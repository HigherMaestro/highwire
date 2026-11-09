//! The program's instruction handlers. The game is `series.rs` (tested for parity with the TypeScript); this file is
//! accounts and money. Rules it keeps (docs/wager-mode.md 6.3, 7.2, 7.7):
//! - stakes leave a series account only to its two players, or the snapshotted fee to the fee account fixed at open;
//! - a player is whoever signed, matched against the two wallets stored at open, never a value in instruction data;
//! - the authority can pause new series, change limits within hard caps, rotate the ticket key and freeze-and-refund,
//!   and nothing else: it can't touch an open series' moves or pay anyone but the players;
//! - an account that's done is closed, its rent to player A, who paid it;
//! - no payee can block a payout: a share the runtime won't credit (an executable or loader-owned account) burns.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader, bpf_loader_deprecated,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint::ProgramResult,
    incinerator, loader_v4,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use crate::error::{series as series_err, WagerError};
use crate::instruction::{ConfigInit, ConfigUpdate, WagerInstruction};
use crate::rules::{Fallback, DUELS_1};
use crate::series::{Reveal, Series, PLAYER_A, PLAYER_B};
use crate::state::*;
use crate::ticket::{self, Ticket};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = WagerInstruction::try_from_slice(data).map_err(|_| WagerError::BadInstruction)?;
    match ix {
        WagerInstruction::InitConfig(c) => init_config(program_id, accounts, c),
        WagerInstruction::UpdateConfig(u) => update_config(program_id, accounts, u),
        WagerInstruction::Open { series_id, player_b, stake, accept_deadline, expiry, key_id, fallback_hash } => {
            open(program_id, accounts, series_id, player_b, stake, accept_deadline, expiry, key_id, fallback_hash)
        }
        WagerInstruction::Accept { fallback_hash } => accept(program_id, accounts, fallback_hash),
        WagerInstruction::Cancel => cancel(program_id, accounts),
        WagerInstruction::Commit { round, hash } => play(program_id, accounts, |s, p, now| s.commit(p, round, hash, now)),
        WagerInstruction::Reveal { pull, nonce } => play(program_id, accounts, |s, p, now| s.reveal(p, Reveal::Pull { pull, nonce }, now)),
        WagerInstruction::RevealFallback { kind, pull, salt } => {
            play(program_id, accounts, |s, p, now| s.reveal(p, Reveal::Fallback { fallback: Fallback { kind, pull }, salt }, now))
        }
        WagerInstruction::Timeout => timeout(program_id, accounts),
        WagerInstruction::Settle => settle(program_id, accounts),
        WagerInstruction::Retire => play(program_id, accounts, |s, p, _| s.retire(p)),
        WagerInstruction::EmergencyRefund => refund_all(program_id, accounts, false),
        WagerInstruction::FreezeAndRefund => refund_all(program_id, accounts, true),
    }
}

// ---------------------------------------------------------------- helpers

fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

fn config_address(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}

pub fn series_address(program_id: &Pubkey, series_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SERIES_SEED, series_id], program_id)
}

fn load_config(program_id: &Pubkey, acc: &AccountInfo) -> Result<Config, ProgramError> {
    if acc.owner != program_id || *acc.key != config_address(program_id).0 {
        return Err(WagerError::NotConfig.into());
    }
    Config::deserialize(&mut &acc.data.borrow()[..]).map_err(|_| WagerError::NotConfig.into())
}

fn save<T: BorshSerialize>(value: &T, acc: &AccountInfo) -> ProgramResult {
    let bytes = borsh::to_vec(value).map_err(|_| WagerError::Math)?;
    let mut data = acc.data.borrow_mut();
    if bytes.len() > data.len() {
        return Err(WagerError::Math.into());
    }
    data[..bytes.len()].copy_from_slice(&bytes);
    Ok(())
}

fn load_series(program_id: &Pubkey, acc: &AccountInfo) -> Result<SeriesAccount, ProgramError> {
    if acc.owner != program_id {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    let s = SeriesAccount::deserialize(&mut &acc.data.borrow()[..]).map_err(|_| WagerError::WrongSeriesAccount)?;
    if *acc.key != series_address(program_id, &s.header.series_id).0 {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    Ok(s)
}

/// Just the fixed-size header: what the refunds need, whatever follows it.
fn load_header(program_id: &Pubkey, acc: &AccountInfo) -> Result<SeriesHeader, ProgramError> {
    if acc.owner != program_id {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    let data = acc.data.borrow();
    let h = SeriesHeader::deserialize(&mut &data[..]).map_err(|_| WagerError::WrongSeriesAccount)?;
    if *acc.key != series_address(program_id, &h.series_id).0 {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    Ok(h)
}

/// Moves lamports out of a program-owned account.
fn pay(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> ProgramResult {
    if lamports == 0 {
        return Ok(());
    }
    let left = from.lamports().checked_sub(lamports).ok_or(WagerError::Math)?;
    let got = to.lamports().checked_add(lamports).ok_or(WagerError::Math)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = got;
    Ok(())
}

/// Whether the runtime would refuse to credit this account: a program, or anything a loader owns. A player can turn its
/// own wallet into one (empty it, then deploy a program at its address), and without this check that would block every
/// payout that touches it, the other player's included.
const NATIVE_LOADER: Pubkey = solana_program::pubkey!("NativeLoader1111111111111111111111111111111");

fn uncreditable(acc: &AccountInfo) -> bool {
    acc.executable || [bpf_loader_upgradeable::ID, bpf_loader::ID, bpf_loader_deprecated::ID, loader_v4::ID, NATIVE_LOADER].contains(acc.owner)
}

fn incinerator_account<'a, 'b>(acc: &'a AccountInfo<'b>) -> Result<&'a AccountInfo<'b>, ProgramError> {
    if *acc.key != incinerator::ID {
        return Err(WagerError::NotIncinerator.into());
    }
    Ok(acc)
}

/// Pays a player, or burns the share if the runtime won't credit them.
fn pay_player<'a>(from: &AccountInfo<'a>, to: &AccountInfo<'a>, burn: &AccountInfo<'a>, lamports: u64) -> ProgramResult {
    pay(from, if uncreditable(to) { burn } else { to }, lamports)
}

/// Closes a series account: every remaining lamport (its rent, and anything sent to it by mistake) to `to`.
fn close<'a>(series: &AccountInfo<'a>, to: &AccountInfo<'a>, burn: &AccountInfo<'a>) -> ProgramResult {
    pay_player(series, to, burn, series.lamports())?;
    series.data.borrow_mut().fill(0);
    series.realloc(0, false)?;
    series.assign(&system_program::ID);
    Ok(())
}

fn release(config_acc: &AccountInfo, program_id: &Pubkey, lamports: u64) -> ProgramResult {
    let mut c = load_config(program_id, config_acc)?;
    c.open_stake = c.open_stake.saturating_sub(lamports);
    save(&c, config_acc)
}

fn check_limits(c: &ConfigInit) -> ProgramResult {
    if c.fee_bps > FEE_BPS_HARD_MAX {
        return Err(WagerError::BadFee.into());
    }
    if c.max_stake > STAKE_HARD_MAX || c.tiers.iter().any(|t| *t > c.max_stake || (*t != 0 && *t < STAKE_HARD_MIN)) {
        return Err(WagerError::OverStakeCap.into());
    }
    if !(60..=REVEAL_SECONDS_MAX).contains(&c.reveal_seconds) {
        return Err(WagerError::BadInstruction.into());
    }
    Ok(())
}

// ---------------------------------------------------------------- config

fn init_config(program_id: &Pubkey, accounts: &[AccountInfo], c: ConfigInit) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let config = next_account_info(it)?;
    let program_data = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !payer.is_signer || *system.key != system_program::ID {
        return Err(WagerError::NotAuthority.into());
    }
    // Only the program's upgrade authority may set it up, so nobody can front-run the deploy with their own config.
    let (pd, _) = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID);
    if *program_data.key != pd || *program_data.owner != bpf_loader_upgradeable::ID {
        return Err(WagerError::NotAuthority.into());
    }
    let state: UpgradeableLoaderState = bincode_like_program_data(&program_data.data.borrow())?;
    match state {
        UpgradeableLoaderState::ProgramData { upgrade_authority_address: Some(a), .. } if a == *payer.key => {}
        _ => return Err(WagerError::NotAuthority.into()),
    }
    check_limits(&c)?;
    let (addr, bump) = config_address(program_id);
    if *config.key != addr {
        return Err(WagerError::NotConfig.into());
    }
    if config.lamports() > 0 && config.owner == program_id {
        return Err(WagerError::AlreadyInitialised.into());
    }
    create_pda(payer, config, system, program_id, Config::LEN, 0, &[CONFIG_SEED, &[bump]])?;
    let cfg = Config {
        version: 1,
        authority: c.authority,
        ticket_key: c.ticket_key,
        ticket_key_id: c.ticket_key_id,
        paused: false,
        fee_bps: c.fee_bps,
        fee_account: c.fee_account,
        tiers: c.tiers,
        max_stake: c.max_stake,
        open_stake_cap: c.open_stake_cap,
        open_stake: 0,
        reveal_seconds: c.reveal_seconds,
        rules: DUELS_1,
    };
    save(&cfg, config)
}

/// The program-data account's state: a u32 tag, then (for ProgramData) the slot and an optional authority.
fn bincode_like_program_data(data: &[u8]) -> Result<UpgradeableLoaderState, ProgramError> {
    // Layout (bincode): tag u32 = 3, slot u64, Option<Pubkey> (u8 flag + 32 bytes).
    if data.len() < 4 + 8 + 1 || u32::from_le_bytes([data[0], data[1], data[2], data[3]]) != 3 {
        return Err(WagerError::NotAuthority.into());
    }
    let slot = u64::from_le_bytes(data[4..12].try_into().map_err(|_| WagerError::NotAuthority)?);
    let authority = match data[12] {
        0 => None,
        1 if data.len() >= 13 + 32 => Some(Pubkey::new_from_array(data[13..45].try_into().map_err(|_| WagerError::NotAuthority)?)),
        _ => return Err(WagerError::NotAuthority.into()),
    };
    Ok(UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address: authority })
}

fn update_config(program_id: &Pubkey, accounts: &[AccountInfo], u: ConfigUpdate) -> ProgramResult {
    let it = &mut accounts.iter();
    let authority = next_account_info(it)?;
    let config = next_account_info(it)?;
    let mut c = load_config(program_id, config)?;
    if !authority.is_signer || *authority.key != c.authority {
        return Err(WagerError::NotAuthority.into());
    }
    if let Some(a) = u.authority {
        c.authority = a;
    }
    if let Some((k, id)) = u.ticket_key {
        c.ticket_key = k;
        c.ticket_key_id = id;
    }
    if let Some(p) = u.paused {
        c.paused = p;
    }
    if let Some(f) = u.fee_bps {
        c.fee_bps = f;
    }
    if let Some(f) = u.fee_account {
        c.fee_account = f;
    }
    if let Some(t) = u.tiers {
        c.tiers = t;
    }
    if let Some(m) = u.max_stake {
        c.max_stake = m;
    }
    if let Some(m) = u.open_stake_cap {
        c.open_stake_cap = m;
    }
    check_limits(&ConfigInit {
        authority: c.authority,
        ticket_key: c.ticket_key,
        ticket_key_id: c.ticket_key_id,
        fee_bps: c.fee_bps,
        fee_account: c.fee_account,
        tiers: c.tiers,
        max_stake: c.max_stake,
        open_stake_cap: c.open_stake_cap,
        reveal_seconds: c.reveal_seconds,
    })?;
    save(&c, config)
}

/// Creates a program-owned PDA funded with its rent plus `extra`, even if someone has already sent lamports to its address
/// (which would make a plain `create_account` fail: a cheap way to block a series).
fn create_pda<'a>(payer: &AccountInfo<'a>, pda: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, space: usize, extra: u64, seeds: &[&[u8]]) -> ProgramResult {
    let need = Rent::get()?.minimum_balance(space).checked_add(extra).ok_or(WagerError::Math)?;
    if pda.lamports() == 0 {
        invoke_signed(&system_instruction::create_account(payer.key, pda.key, need, space as u64, program_id), &[payer.clone(), pda.clone(), system.clone()], &[seeds])?;
        return Ok(());
    }
    if pda.owner != &system_program::ID || !pda.data_is_empty() {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    let top_up = need.saturating_sub(pda.lamports());
    if top_up > 0 {
        invoke(&system_instruction::transfer(payer.key, pda.key, top_up), &[payer.clone(), pda.clone(), system.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(pda.key, space as u64), &[pda.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(pda.key, program_id), &[pda.clone(), system.clone()], &[seeds])?;
    Ok(())
}

// ---------------------------------------------------------------- opening a series

#[allow(clippy::too_many_arguments)]
fn open(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    series_id: [u8; 32],
    player_b: Pubkey,
    stake: u64,
    accept_deadline: i64,
    expiry: i64,
    key_id: u16,
    fallback_hash: [u8; 32],
) -> ProgramResult {
    let it = &mut accounts.iter();
    let player_a = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let series_acc = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let system = next_account_info(it)?;
    // A plain wallet: something that pays its stake from its own lamports, and that can be paid.
    if !player_a.is_signer || *system.key != system_program::ID || *player_a.owner != system_program::ID || uncreditable(player_a) {
        return Err(WagerError::NotAPlayer.into());
    }
    let mut c = load_config(program_id, config_acc)?;
    if c.paused {
        return Err(WagerError::Paused.into());
    }
    if stake == 0 || stake > c.max_stake || !c.tiers.contains(&stake) {
        return Err(WagerError::BadTier.into());
    }
    if player_b == *player_a.key {
        return Err(WagerError::NotAPlayer.into());
    }
    let t = now()?;
    if t > expiry || accept_deadline > expiry || key_id != c.ticket_key_id {
        return Err(WagerError::TicketExpired.into());
    }
    let ticket = Ticket { series_id, player_a: *player_a.key, player_b, stake, accept_deadline, expiry, key_id };
    ticket::verify(program_id, ixs, &c.ticket_key, &ticket)?;
    let both = stake.checked_mul(2).ok_or(WagerError::Math)?;
    let open_stake = c.open_stake.checked_add(both).ok_or(WagerError::Math)?;
    if open_stake > c.open_stake_cap {
        return Err(WagerError::OverOpenStakeCap.into());
    }
    let (addr, bump) = series_address(program_id, &series_id);
    if *series_acc.key != addr {
        return Err(WagerError::WrongSeriesAccount.into());
    }
    if series_acc.owner == program_id {
        return Err(WagerError::WrongStatus.into()); // already opened
    }
    create_pda(player_a, series_acc, system, program_id, SeriesAccount::LEN, stake, &[SERIES_SEED, &series_id, &[bump]])?;
    let account = SeriesAccount {
        header: SeriesHeader {
            version: 1,
            status: STATUS_OPEN,
            series_id,
            player_a: *player_a.key,
            player_b,
            stake,
            fee_bps: c.fee_bps,
            fee_account: c.fee_account,
            ticket_key_id: key_id,
            accept_deadline,
            ticket_expiry: expiry,
            last_change: t,
            fallback_hash_a: fallback_hash,
        },
        series: None,
    };
    save(&account, series_acc)?;
    // Reserve both stakes against the cap now, so an accept can't push it over.
    c.open_stake = open_stake;
    save(&c, config_acc)
}

fn accept(program_id: &Pubkey, accounts: &[AccountInfo], fallback_hash: [u8; 32]) -> ProgramResult {
    let it = &mut accounts.iter();
    let player_b = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let series_acc = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let system = next_account_info(it)?;
    let c = load_config(program_id, config_acc)?;
    if c.paused {
        return Err(WagerError::Paused.into());
    }
    let mut s = load_series(program_id, series_acc)?;
    let h = s.header.clone();
    if !player_b.is_signer || *player_b.key != h.player_b || *system.key != system_program::ID {
        return Err(WagerError::NotAPlayer.into());
    }
    if h.status != STATUS_OPEN {
        return Err(WagerError::WrongStatus.into());
    }
    let t = now()?;
    if t > h.accept_deadline {
        return Err(WagerError::AcceptDeadlinePassed.into());
    }
    // The same ticket A opened with, and still under the key that signed it: after a rotation B can't accept, and A cancels.
    if h.ticket_key_id != c.ticket_key_id {
        return Err(WagerError::BadTicket.into());
    }
    let ticket = Ticket { series_id: h.series_id, player_a: h.player_a, player_b: h.player_b, stake: h.stake, accept_deadline: h.accept_deadline, expiry: h.ticket_expiry, key_id: h.ticket_key_id };
    ticket::verify(program_id, ixs, &c.ticket_key, &ticket)?;
    invoke(&system_instruction::transfer(player_b.key, series_acc.key, h.stake), &[player_b.clone(), series_acc.clone(), system.clone()])?;
    s.header.status = STATUS_LIVE;
    s.header.last_change = t;
    s.series = Some(Series::start(c.rules, c.reveal_seconds, h.series_id, [h.fallback_hash_a, fallback_hash], t));
    save(&s, series_acc)
}

fn cancel(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let caller = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let series_acc = next_account_info(it)?;
    let player_a = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    let h = load_header(program_id, series_acc)?;
    if h.status != STATUS_OPEN {
        return Err(WagerError::WrongStatus.into());
    }
    if *player_a.key != h.player_a {
        return Err(WagerError::WrongPayee.into());
    }
    let by_a = caller.is_signer && *caller.key == h.player_a;
    if !by_a && now()? <= h.accept_deadline {
        return Err(WagerError::NotYet.into());
    }
    release(config_acc, program_id, h.stake.checked_mul(2).ok_or(WagerError::Math)?)?;
    close(series_acc, player_a, burn)
}

// ---------------------------------------------------------------- playing

/// Runs a player's move: the player is whoever signed, matched against the two stored wallets.
fn play(program_id: &Pubkey, accounts: &[AccountInfo], f: impl FnOnce(&mut Series, u8, i64) -> Result<(), crate::series::SeriesError>) -> ProgramResult {
    let it = &mut accounts.iter();
    let signer = next_account_info(it)?;
    let series_acc = next_account_info(it)?;
    let mut s = load_series(program_id, series_acc)?;
    if s.header.status != STATUS_LIVE {
        return Err(WagerError::WrongStatus.into());
    }
    let player = if signer.is_signer && *signer.key == s.header.player_a {
        PLAYER_A
    } else if signer.is_signer && *signer.key == s.header.player_b {
        PLAYER_B
    } else {
        return Err(WagerError::NotAPlayer.into());
    };
    let t = now()?;
    let series = s.series.as_mut().ok_or(WagerError::WrongStatus)?;
    f(series, player, t).map_err(series_err)?;
    s.header.last_change = t;
    save(&s, series_acc)
}

fn timeout(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let series_acc = next_account_info(it)?;
    let mut s = load_series(program_id, series_acc)?;
    if s.header.status != STATUS_LIVE {
        return Err(WagerError::WrongStatus.into());
    }
    let t = now()?;
    s.series.as_mut().ok_or(WagerError::WrongStatus)?.timeout(t).map_err(series_err)?;
    s.header.last_change = t;
    save(&s, series_acc)
}

// ---------------------------------------------------------------- paying out

fn settle(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let series_acc = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let player_a = next_account_info(it)?;
    let player_b = next_account_info(it)?;
    let fee_acc = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    let s = load_series(program_id, series_acc)?;
    let h = &s.header;
    if h.status != STATUS_LIVE {
        return Err(WagerError::WrongStatus.into());
    }
    let ending = s.series.as_ref().and_then(|x| x.ending).ok_or(WagerError::NotOver)?;
    if *player_a.key != h.player_a || *player_b.key != h.player_b || *fee_acc.key != h.fee_account {
        return Err(WagerError::WrongPayee.into());
    }
    let pot = h.stake.checked_mul(2).ok_or(WagerError::Math)?;
    match ending.winner {
        None => {
            pay_player(series_acc, player_a, burn, h.stake)?;
            pay_player(series_acc, player_b, burn, h.stake)?;
        }
        Some(w) => {
            let mut fee = ((pot as u128) * (h.fee_bps as u128) / 10_000) as u64;
            // A fee the fee account can't take (it's empty and the fee is under its rent-exempt minimum, or it isn't
            // creditable) goes to the winner: Highwire's own setup must never hold a winner's payout.
            let fee_ok = !uncreditable(fee_acc)
                && fee_acc.lamports().checked_add(fee).ok_or(WagerError::Math)? >= Rent::get()?.minimum_balance(fee_acc.data_len());
            if !fee_ok {
                fee = 0;
            }
            let winner = if w == PLAYER_A { player_a } else { player_b };
            pay_player(series_acc, winner, burn, pot.checked_sub(fee).ok_or(WagerError::Math)?)?;
            pay(series_acc, fee_acc, fee)?;
        }
    }
    release(config_acc, program_id, pot)?;
    close(series_acc, player_a, burn)
}

/// Refunds both stakes in full and closes the series: anyone after 24 hours without a change (unless it's over and only
/// needs settling), or the authority at any time. Works from the fixed-size header, whatever follows it.
fn refund_all(program_id: &Pubkey, accounts: &[AccountInfo], by_authority: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    if by_authority {
        let authority = next_account_info(it)?;
        let config_acc = next_account_info(it)?;
        let c = load_config(program_id, config_acc)?;
        if !authority.is_signer || *authority.key != c.authority {
            return Err(WagerError::NotAuthority.into());
        }
        let series_acc = next_account_info(it)?;
        let player_a = next_account_info(it)?;
        let player_b = next_account_info(it)?;
        let burn = incinerator_account(next_account_info(it)?)?;
        return refund(program_id, config_acc, series_acc, player_a, player_b, burn, false);
    }
    let series_acc = next_account_info(it)?;
    let config_acc = next_account_info(it)?;
    let player_a = next_account_info(it)?;
    let player_b = next_account_info(it)?;
    let burn = incinerator_account(next_account_info(it)?)?;
    refund(program_id, config_acc, series_acc, player_a, player_b, burn, true)
}

fn refund<'a>(
    program_id: &Pubkey,
    config_acc: &AccountInfo<'a>,
    series_acc: &AccountInfo<'a>,
    player_a: &AccountInfo<'a>,
    player_b: &AccountInfo<'a>,
    burn: &AccountInfo<'a>,
    after_idle: bool,
) -> ProgramResult {
    let h = load_header(program_id, series_acc)?;
    if *player_a.key != h.player_a || *player_b.key != h.player_b {
        return Err(WagerError::WrongPayee.into());
    }
    let t = now()?;
    if after_idle && t.saturating_sub(h.last_change) < EMERGENCY_AFTER_SECONDS {
        return Err(WagerError::NotYet.into());
    }
    // A series that's over, or that the timeouts already due would decide, settles: an idle 24 hours mustn't let the
    // loser take back what they lost. Only a series this version can't read at all (a layout change) is refunded unread.
    if after_idle && h.status == STATUS_LIVE {
        if let Ok(SeriesAccount { series: Some(mut s), .. }) = SeriesAccount::deserialize(&mut &series_acc.data.borrow()[..]) {
            // Each timeout either ends a match, opens a phase at `t` (so the next is StillOpen) or fails: a handful at most.
            for _ in 0..16 {
                if s.ending.is_some() || s.timeout(t).is_err() {
                    break;
                }
            }
            if s.ending.is_some() {
                return Err(WagerError::Decided.into());
            }
        }
    }
    match h.status {
        STATUS_OPEN => {}
        STATUS_LIVE => pay_player(series_acc, player_b, burn, h.stake)?,
        _ => return Err(WagerError::WrongStatus.into()),
    }
    release(config_acc, program_id, h.stake.checked_mul(2).ok_or(WagerError::Math)?)?;
    // A's stake and the rent go back to A.
    close(series_acc, player_a, burn)
}
