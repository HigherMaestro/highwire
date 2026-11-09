//! The program end to end under solana-program-test: every instruction, with real Ed25519 tickets and real lamports.
//! `npm run test:program` runs these twice: natively, then (with SBF_OUT_DIR) against the built .so.

use borsh::BorshDeserialize;
use line_wager::error::WagerError;
use line_wager::instruction::{ConfigInit, ConfigUpdate, WagerInstruction};
use line_wager::processor::series_address;
use line_wager::rules::{SIDE_A, SIDE_B};
use line_wager::series::{move_commitment, side_of, Series, PHASE_COMMIT, PHASE_REVEAL, PLAYER_A, PLAYER_B};
use line_wager::state::{Config, SeriesAccount, CONFIG_SEED, EMERGENCY_AFTER_SECONDS, STATUS_LIVE, STATUS_OPEN};
use line_wager::ticket::Ticket;
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    ed25519_instruction::new_ed25519_instruction,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::{Transaction, TransactionError},
};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_800_000_000;
const STAKE: u64 = SOL / 10;
const FEE_BPS: u16 = 250;

fn program_id() -> Pubkey {
    line_wager::id()
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &program_id()).0
}

fn ticket_keypair(seed: u8) -> ed25519_dalek::Keypair {
    let secret = ed25519_dalek::SecretKey::from_bytes(&[seed; 32]).unwrap();
    let public = ed25519_dalek::PublicKey::from(&secret);
    ed25519_dalek::Keypair { secret, public }
}

fn ix(data: WagerInstruction, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: program_id(), accounts, data: borsh::to_vec(&data).unwrap() }
}

struct Env {
    ctx: ProgramTestContext,
    authority: Keypair,
    ticket_key: ed25519_dalek::Keypair,
    fee: Pubkey,
    a: Keypair,
    b: Keypair,
    stranger: Keypair,
    nonce: u32,
}

/// A failed transaction's instruction index and custom code.
type Failure = (u8, u32);

fn failure(r: Result<(), BanksClientError>) -> Option<Failure> {
    match r {
        Ok(()) => None,
        Err(e) => match e.unwrap() {
            TransactionError::InstructionError(i, InstructionError::Custom(n)) => Some((i, n)),
            other => panic!("not a custom error: {other:?}"),
        },
    }
}

fn code(e: WagerError) -> u32 {
    e as u32
}

impl Env {
    /// A test validator with the program, a fake program-data account naming `authority` as upgrade authority, and
    /// funded wallets. The clock is at T0.
    async fn new() -> Env {
        let mut pt = ProgramTest::new("line_wager", program_id(), processor!(line_wager::processor::process));
        let authority = Keypair::new();
        let (a, b, stranger) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&authority, &a, &b, &stranger] {
            pt.add_account(k.pubkey(), Account { lamports: 100 * SOL, owner: system_program::ID, ..Account::default() });
        }
        let fee = Pubkey::new_unique();
        pt.add_account(fee, Account { lamports: SOL, owner: system_program::ID, ..Account::default() });
        let pd = Pubkey::find_program_address(&[program_id().as_ref()], &bpf_loader_upgradeable::ID).0;
        let mut data = vec![3, 0, 0, 0];
        data.extend_from_slice(&42u64.to_le_bytes());
        data.push(1);
        data.extend_from_slice(authority.pubkey().as_ref());
        pt.add_account(pd, Account { lamports: SOL, data, owner: bpf_loader_upgradeable::ID, ..Account::default() });
        let ctx = pt.start_with_context().await;
        let mut env = Env { ctx, authority, ticket_key: ticket_keypair(7), fee, a, b, stranger, nonce: 0 };
        env.set_time(T0).await;
        env
    }

    fn init(&self) -> ConfigInit {
        ConfigInit {
            authority: self.authority.pubkey(),
            ticket_key: Pubkey::new_from_array(self.ticket_key.public.to_bytes()),
            ticket_key_id: 1,
            fee_bps: FEE_BPS,
            fee_account: self.fee,
            tiers: [SOL / 100, STAKE, SOL, 0],
            max_stake: SOL,
            open_stake_cap: 3 * SOL,
            reveal_seconds: 120,
        }
    }

    async fn ready() -> Env {
        let mut env = Env::new().await;
        let init = env.init();
        assert_eq!(env.init_config(&clone(&env.authority), init).await, None);
        env
    }

    async fn set_time(&mut self, t: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = t;
        self.ctx.set_sysvar(&clock);
    }

    /// Sends `ixs` paid for by the test payer (so the players' balances move only by their stakes), with a compute
    /// budget instruction at the end to keep otherwise identical transactions apart.
    async fn send(&mut self, mut ixs: Vec<Instruction>, signers: &[&Keypair]) -> Option<Failure> {
        self.nonce += 1;
        ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(1_400_000 - self.nonce));
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&self.ctx.payer.pubkey()), &all, self.ctx.last_blockhash);
        failure(self.ctx.banks_client.process_transaction(tx).await)
    }

    async fn init_config(&mut self, payer: &Keypair, init: ConfigInit) -> Option<Failure> {
        let pd = Pubkey::find_program_address(&[program_id().as_ref()], &bpf_loader_upgradeable::ID).0;
        let i = ix(
            WagerInstruction::InitConfig(init),
            vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config_address(), false), AccountMeta::new_readonly(pd, false), AccountMeta::new_readonly(system_program::ID, false)],
        );
        self.send(vec![i], &[payer]).await
    }

    async fn update(&mut self, signer: &Keypair, u: ConfigUpdate) -> Option<Failure> {
        let i = ix(WagerInstruction::UpdateConfig(u), vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(config_address(), false)]);
        self.send(vec![i], &[signer]).await
    }

    fn ticket(&self, id: [u8; 32]) -> Ticket {
        Ticket { series_id: id, player_a: self.a.pubkey(), player_b: self.b.pubkey(), stake: STAKE, accept_deadline: T0 + 300, expiry: T0 + 600, key_id: 1 }
    }

    fn signed(&self, t: &Ticket) -> Instruction {
        new_ed25519_instruction(&self.ticket_key, &t.message(&program_id()))
    }

    fn open_ix(&self, t: &Ticket, fallback_hash: [u8; 32]) -> Instruction {
        ix(
            WagerInstruction::Open { series_id: t.series_id, player_b: t.player_b, stake: t.stake, accept_deadline: t.accept_deadline, expiry: t.expiry, key_id: t.key_id, fallback_hash },
            vec![
                AccountMeta::new(t.player_a, true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(series_address(&program_id(), &t.series_id).0, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    fn accept_ix(&self, t: &Ticket, signer: &Pubkey) -> Instruction {
        ix(
            WagerInstruction::Accept { fallback_hash: [0xbb; 32] },
            vec![
                AccountMeta::new(*signer, true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(series_address(&program_id(), &t.series_id).0, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    async fn open(&mut self, t: &Ticket) -> Option<Failure> {
        let ixs = vec![self.signed(t), self.open_ix(t, [0xaa; 32])];
        let a = clone(&self.a);
        self.send(ixs, &[&a]).await
    }

    async fn accept(&mut self, t: &Ticket) -> Option<Failure> {
        let ixs = vec![self.signed(t), self.accept_ix(t, &t.player_b)];
        let b = clone(&self.b);
        self.send(ixs, &[&b]).await
    }

    /// Opens and accepts a series at the current time; returns its ticket.
    async fn live(&mut self, seed: u8) -> Ticket {
        let t = self.ticket([seed; 32]);
        assert_eq!(self.open(&t).await, None);
        assert_eq!(self.accept(&t).await, None);
        t
    }

    async fn play(&mut self, who: &Keypair, id: &[u8; 32], data: WagerInstruction) -> Option<Failure> {
        let i = ix(data, vec![AccountMeta::new_readonly(who.pubkey(), true), AccountMeta::new(series_address(&program_id(), id).0, false)]);
        let who = clone(who);
        self.send(vec![i], &[&who]).await
    }

    async fn timeout(&mut self, id: &[u8; 32]) -> Option<Failure> {
        self.send(vec![ix(WagerInstruction::Timeout, vec![AccountMeta::new(series_address(&program_id(), id).0, false)])], &[]).await
    }

    fn payout_accounts(&self, id: &[u8; 32], fee: Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(series_address(&program_id(), id).0, false),
            AccountMeta::new(config_address(), false),
            AccountMeta::new(self.a.pubkey(), false),
            AccountMeta::new(self.b.pubkey(), false),
            AccountMeta::new(fee, false),
        ]
    }

    async fn settle(&mut self, id: &[u8; 32]) -> Option<Failure> {
        let accounts = self.payout_accounts(id, self.fee);
        self.send(vec![ix(WagerInstruction::Settle, accounts)], &[]).await
    }

    async fn cancel(&mut self, caller: &Keypair, signs: bool, id: &[u8; 32], refund_to: Pubkey) -> Option<Failure> {
        let accounts = vec![
            AccountMeta::new_readonly(caller.pubkey(), signs),
            AccountMeta::new(config_address(), false),
            AccountMeta::new(series_address(&program_id(), id).0, false),
            AccountMeta::new(refund_to, false),
        ];
        let caller = clone(caller);
        let signers: Vec<&Keypair> = if signs { vec![&caller] } else { vec![] };
        self.send(vec![ix(WagerInstruction::Cancel, accounts)], &signers).await
    }

    async fn emergency(&mut self, id: &[u8; 32]) -> Option<Failure> {
        let mut accounts = self.payout_accounts(id, self.fee);
        accounts.pop();
        self.send(vec![ix(WagerInstruction::EmergencyRefund, accounts)], &[]).await
    }

    async fn freeze(&mut self, signer: &Keypair, id: &[u8; 32]) -> Option<Failure> {
        let accounts = vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(config_address(), false),
            AccountMeta::new(series_address(&program_id(), id).0, false),
            AccountMeta::new(self.a.pubkey(), false),
            AccountMeta::new(self.b.pubkey(), false),
        ];
        let signer = clone(signer);
        self.send(vec![ix(WagerInstruction::FreezeAndRefund, accounts)], &[&signer]).await
    }

    async fn balance(&mut self, k: Pubkey) -> u64 {
        self.ctx.banks_client.get_balance(k).await.unwrap()
    }

    async fn config(&mut self) -> Config {
        let acc = self.ctx.banks_client.get_account(config_address()).await.unwrap().unwrap();
        Config::deserialize(&mut &acc.data[..]).unwrap()
    }

    async fn series(&mut self, id: &[u8; 32]) -> Option<SeriesAccount> {
        let acc = self.ctx.banks_client.get_account(series_address(&program_id(), id).0).await.unwrap()?;
        Some(SeriesAccount::deserialize(&mut &acc.data[..]).unwrap())
    }

    async fn rent(&mut self) -> u64 {
        self.ctx.banks_client.get_rent().await.unwrap().minimum_balance(SeriesAccount::LEN)
    }

    /// Both players commit and reveal one round: A pulls `pull_a` (capped at its energy), B nothing.
    async fn round(&mut self, id: &[u8; 32], pull_a: u8) {
        let s = self.series(id).await.unwrap().series.unwrap();
        assert_eq!(s.phase, PHASE_COMMIT);
        let (m, r) = (s.match_index, s.game.rounds + 1);
        let moves = [(clone(&self.a), PLAYER_A, pull_a.min(s.game.energy[side_of(PLAYER_A, m) as usize])), (clone(&self.b), PLAYER_B, 0)];
        let nonce = |p: u8| [m * 64 + r * 2 + p; 32];
        for (k, p, pull) in &moves {
            let hash = move_commitment(id, m, r, side_of(*p, m), *pull, &nonce(*p));
            assert_eq!(self.play(k, id, WagerInstruction::Commit { round: r, hash }).await, None);
        }
        assert_eq!(self.series(id).await.unwrap().series.unwrap().phase, PHASE_REVEAL);
        for (k, p, pull) in &moves {
            assert_eq!(self.play(k, id, WagerInstruction::Reveal { pull: *pull, nonce: nonce(*p) }).await, None);
        }
    }
}

fn clone(k: &Keypair) -> Keypair {
    Keypair::from_bytes(&k.to_bytes()).unwrap()
}

// ---------------------------------------------------------------- config

#[tokio::test]
async fn only_the_upgrade_authority_initialises_the_config_once() {
    let mut env = Env::new().await;
    let init = env.init();
    let stranger = clone(&env.stranger);
    assert_eq!(env.init_config(&stranger, init.clone()).await, Some((0, code(WagerError::NotAuthority))));
    let authority = clone(&env.authority);
    assert_eq!(env.init_config(&authority, ConfigInit { fee_bps: 501, ..init.clone() }).await, Some((0, code(WagerError::BadFee))));
    assert_eq!(env.init_config(&authority, ConfigInit { max_stake: 11 * SOL, ..init.clone() }).await, Some((0, code(WagerError::OverStakeCap))));
    assert_eq!(env.init_config(&authority, ConfigInit { tiers: [2 * SOL, 0, 0, 0], ..init.clone() }).await, Some((0, code(WagerError::OverStakeCap))));
    assert_eq!(env.init_config(&authority, init.clone()).await, None);
    assert_eq!(env.init_config(&authority, init).await, Some((0, code(WagerError::AlreadyInitialised))));
    let c = env.config().await;
    assert_eq!((c.fee_bps, c.open_stake, c.paused, c.authority), (FEE_BPS, 0, false, env.authority.pubkey()));
}

#[tokio::test]
async fn a_config_address_funded_in_advance_still_initialises() {
    let mut env = Env::new().await;
    let stranger = clone(&env.stranger);
    assert_eq!(env.send(vec![system_instruction::transfer(&stranger.pubkey(), &config_address(), SOL / 100)], &[&stranger]).await, None);
    let (authority, init) = (clone(&env.authority), env.init());
    assert_eq!(env.init_config(&authority, init).await, None);
    assert_eq!(env.config().await.fee_bps, FEE_BPS);
}

#[tokio::test]
async fn updates_are_the_authoritys_and_stay_inside_the_hard_caps() {
    let mut env = Env::ready().await;
    let (authority, stranger) = (clone(&env.authority), clone(&env.stranger));
    assert_eq!(env.update(&stranger, ConfigUpdate { paused: Some(true), ..Default::default() }).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.update(&authority, ConfigUpdate { fee_bps: Some(501), ..Default::default() }).await, Some((0, code(WagerError::BadFee))));
    assert_eq!(env.update(&authority, ConfigUpdate { max_stake: Some(SOL / 2), ..Default::default() }).await, Some((0, code(WagerError::OverStakeCap))));
    assert_eq!(env.update(&authority, ConfigUpdate { fee_bps: Some(100), ..Default::default() }).await, None);
    assert_eq!(env.config().await.fee_bps, 100);
    // Handing over authority: the old one can't act any more.
    assert_eq!(env.update(&authority, ConfigUpdate { authority: Some(stranger.pubkey()), ..Default::default() }).await, None);
    assert_eq!(env.update(&authority, ConfigUpdate { paused: Some(true), ..Default::default() }).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.update(&stranger, ConfigUpdate { paused: Some(true), ..Default::default() }).await, None);
}

// ---------------------------------------------------------------- tickets and opening

#[tokio::test]
async fn open_and_accept_hold_both_stakes() {
    let mut env = Env::ready().await;
    let (a0, b0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await);
    let t = env.ticket([1; 32]);
    assert_eq!(env.open(&t).await, None);
    let rent = env.rent().await;
    let addr = series_address(&program_id(), &t.series_id).0;
    assert_eq!(env.balance(addr).await, rent + STAKE);
    assert_eq!(env.balance(env.a.pubkey()).await, a0 - rent - STAKE);
    assert_eq!(env.config().await.open_stake, 2 * STAKE);
    let s = env.series(&t.series_id).await.unwrap();
    assert_eq!((s.header.status, s.header.fee_bps, s.series.is_none()), (STATUS_OPEN, FEE_BPS, true));
    // The same series can't be opened twice.
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::WrongStatus))));
    // Only B accepts.
    let stranger = clone(&env.stranger);
    let ixs = vec![env.signed(&t), env.accept_ix(&t, &stranger.pubkey())];
    assert_eq!(env.send(ixs, &[&stranger]).await, Some((1, code(WagerError::NotAPlayer))));
    assert_eq!(env.accept(&t).await, None);
    assert_eq!(env.balance(addr).await, rent + 2 * STAKE);
    assert_eq!(env.balance(env.b.pubkey()).await, b0 - STAKE);
    let s = env.series(&t.series_id).await.unwrap();
    assert_eq!(s.header.status, STATUS_LIVE);
    let game = s.series.unwrap();
    assert_eq!((game.phase, game.phase_opened_at, game.fallback_hash), (PHASE_COMMIT, T0, [[0xaa; 32], [0xbb; 32]]));
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::WrongStatus))));
}

#[tokio::test]
async fn bad_tickets_are_refused() {
    let mut env = Env::ready().await;
    let a = clone(&env.a);
    let t = env.ticket([2; 32]);
    let bad = WagerError::BadTicket as u32;

    // No signature instruction at all, or not immediately before.
    assert_eq!(env.send(vec![env.open_ix(&t, [0; 32])], &[&a]).await, Some((0, bad)));
    let ixs = vec![env.signed(&t), ComputeBudgetInstruction::set_compute_unit_price(1), env.open_ix(&t, [0; 32])];
    assert_eq!(env.send(ixs, &[&a]).await, Some((2, bad)));
    // Signed by another key.
    let other = ticket_keypair(9);
    let ixs = vec![new_ed25519_instruction(&other, &t.message(&program_id())), env.open_ix(&t, [0; 32])];
    assert_eq!(env.send(ixs, &[&a]).await, Some((1, bad)));
    // A ticket for another stake, another player, another program.
    for wrong in [Ticket { stake: SOL, ..t }, Ticket { player_b: env.stranger.pubkey(), ..t }] {
        let ixs = vec![env.signed(&wrong), env.open_ix(&t, [0; 32])];
        assert_eq!(env.send(ixs, &[&a]).await, Some((1, bad)));
    }
    let ixs = vec![new_ed25519_instruction(&env.ticket_key, &t.message(&Pubkey::new_unique())), env.open_ix(&t, [0; 32])];
    assert_eq!(env.send(ixs, &[&a]).await, Some((1, bad)));
    // Offsets pointing at another instruction (here the signature instruction itself, by index): the precompile accepts
    // it, the program mustn't.
    let mut sig = env.signed(&t);
    for at in [4usize, 8, 14] {
        sig.data[at..at + 2].copy_from_slice(&0u16.to_le_bytes());
    }
    assert_eq!(env.send(vec![sig, env.open_ix(&t, [0; 32])], &[&a]).await, Some((1, bad)));
    // A forged signature fails in the precompile, before the program runs.
    let mut sig = env.signed(&t);
    let at = u16::from_le_bytes([sig.data[2], sig.data[3]]) as usize;
    sig.data[at] ^= 1;
    let tx = Transaction::new_signed_with_payer(&[sig, env.open_ix(&t, [0; 32])], Some(&env.ctx.payer.pubkey()), &[&env.ctx.payer, &a], env.ctx.last_blockhash);
    let err = env.ctx.banks_client.process_transaction(tx).await.unwrap_err().unwrap();
    // Solana 1.18 reports a failed precompile check this way.
    assert_eq!(err, TransactionError::InvalidAccountIndex);
    // Expired, or under a retired key id.
    env.set_time(T0 + 601).await;
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::TicketExpired))));
    env.set_time(T0).await;
    let old = Ticket { key_id: 0, ..t };
    assert_eq!(env.open(&old).await, Some((1, code(WagerError::TicketExpired))));
    // Nothing above opened anything.
    assert!(env.series(&t.series_id).await.is_none());
    assert_eq!(env.open(&t).await, None);
}

#[tokio::test]
async fn opening_is_inside_the_tiers_the_cap_and_the_pause() {
    let mut env = Env::ready().await;
    let authority = clone(&env.authority);
    assert_eq!(env.open(&Ticket { stake: SOL / 2, ..env.ticket([3; 32]) }).await, Some((1, code(WagerError::BadTier))));
    let me = Ticket { player_b: env.a.pubkey(), ..env.ticket([3; 32]) };
    assert_eq!(env.open(&me).await, Some((1, code(WagerError::NotAPlayer))));
    // The cap counts both stakes from the open: 3 SOL holds one 1-SOL series, not two.
    let big = |seed| Ticket { stake: SOL, ..env.ticket([seed; 32]) };
    let (t1, t2) = (big(4), big(5));
    assert_eq!(env.open(&t1).await, None);
    assert_eq!(env.open(&t2).await, Some((1, code(WagerError::OverOpenStakeCap))));
    assert_eq!(env.config().await.open_stake, 2 * SOL);
    // Paused: nothing opens, nothing is accepted; cancelling still works.
    assert_eq!(env.update(&authority, ConfigUpdate { paused: Some(true), ..Default::default() }).await, None);
    assert_eq!(env.open(&env.ticket([6; 32])).await, Some((1, code(WagerError::Paused))));
    assert_eq!(env.accept(&t1).await, Some((1, code(WagerError::Paused))));
    let a = clone(&env.a);
    assert_eq!(env.cancel(&a, true, &t1.series_id, a.pubkey()).await, None);
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn a_series_address_funded_in_advance_still_opens() {
    let mut env = Env::ready().await;
    let t = env.ticket([7; 32]);
    let addr = series_address(&program_id(), &t.series_id).0;
    let stranger = clone(&env.stranger);
    assert_eq!(env.send(vec![system_instruction::transfer(&stranger.pubkey(), &addr, SOL / 100)], &[&stranger]).await, None);
    assert_eq!(env.open(&t).await, None);
    let rent = env.rent().await;
    assert_eq!(env.balance(addr).await, rent + STAKE);
    assert_eq!(env.accept(&t).await, None);
}

#[tokio::test]
async fn a_rotated_ticket_key_strands_nobody() {
    let mut env = Env::ready().await;
    let t = env.ticket([8; 32]);
    assert_eq!(env.open(&t).await, None);
    let authority = clone(&env.authority);
    let new_key = Pubkey::new_from_array(ticket_keypair(9).public.to_bytes());
    assert_eq!(env.update(&authority, ConfigUpdate { ticket_key: Some((new_key, 2)), ..Default::default() }).await, None);
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::BadTicket))));
    let a = clone(&env.a);
    let a0 = env.balance(a.pubkey()).await;
    let rent = env.rent().await;
    assert_eq!(env.cancel(&a, true, &t.series_id, a.pubkey()).await, None);
    assert_eq!(env.balance(a.pubkey()).await, a0 + rent + STAKE);
}

// ---------------------------------------------------------------- cancelling

#[tokio::test]
async fn cancel_refunds_a_by_a_at_any_time_or_by_anyone_after_the_deadline() {
    let mut env = Env::ready().await;
    let (a, stranger) = (clone(&env.a), clone(&env.stranger));
    let t = env.ticket([10; 32]);
    assert_eq!(env.open(&t).await, None);
    let a0 = env.balance(a.pubkey()).await;
    let rent = env.rent().await;
    assert_eq!(env.cancel(&stranger, true, &t.series_id, a.pubkey()).await, Some((0, code(WagerError::NotYet))));
    assert_eq!(env.cancel(&a, true, &t.series_id, stranger.pubkey()).await, Some((0, code(WagerError::WrongPayee))));
    env.set_time(t.accept_deadline + 1).await;
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::AcceptDeadlinePassed))));
    assert_eq!(env.cancel(&stranger, false, &t.series_id, a.pubkey()).await, None);
    assert_eq!(env.balance(a.pubkey()).await, a0 + rent + STAKE);
    assert!(env.series(&t.series_id).await.is_none(), "closed");
    assert_eq!(env.config().await.open_stake, 0);

    // A live series can't be cancelled.
    env.set_time(T0).await;
    let t = env.live(11).await;
    assert_eq!(env.cancel(&a, true, &t.series_id, a.pubkey()).await, Some((0, code(WagerError::WrongStatus))));
}

// ---------------------------------------------------------------- playing and settling

#[tokio::test]
async fn a_series_played_out_pays_the_winner_less_the_fee() {
    let mut env = Env::ready().await;
    let t = env.live(20).await;
    let id = t.series_id;
    let (a0, b0, f0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await, env.balance(env.fee).await);
    let rent = env.rent().await;
    // A stranger can't move; nor can anyone settle before the end.
    let stranger = clone(&env.stranger);
    assert_eq!(env.play(&stranger, &id, WagerInstruction::Commit { round: 1, hash: [0; 32] }).await, Some((0, code(WagerError::NotAPlayer))));
    assert_eq!(env.settle(&id).await, Some((0, code(WagerError::NotOver))));
    let mut rounds = 0;
    while env.series(&id).await.unwrap().series.unwrap().ending.is_none() {
        env.round(&id, 5).await;
        rounds += 1;
        assert!(rounds < 60, "the series never ended");
    }
    let s: Series = env.series(&id).await.unwrap().series.unwrap();
    assert_eq!(s.ending.unwrap().winner, Some(PLAYER_A));
    assert_eq!(s.results.iter().flatten().filter(|r| r.winner == Some(PLAYER_A)).count(), 3);
    // Both sides were played: A took side b in match 1.
    assert_eq!((side_of(PLAYER_A, 0), side_of(PLAYER_A, 1)), (SIDE_A, SIDE_B));
    // Paid to the payees fixed at open, nowhere else.
    let accounts = env.payout_accounts(&id, stranger.pubkey());
    assert_eq!(env.send(vec![ix(WagerInstruction::Settle, accounts)], &[]).await, Some((0, code(WagerError::WrongPayee))));
    assert_eq!(env.settle(&id).await, None);
    let fee = 2 * STAKE * FEE_BPS as u64 / 10_000;
    assert_eq!(env.balance(env.a.pubkey()).await, a0 + 2 * STAKE - fee + rent);
    assert_eq!(env.balance(env.b.pubkey()).await, b0);
    assert_eq!(env.balance(env.fee).await, f0 + fee);
    assert!(env.series(&id).await.is_none(), "closed");
    assert_eq!(env.config().await.open_stake, 0);
    assert_eq!(env.settle(&id).await, Some((0, code(WagerError::WrongSeriesAccount))));
}

#[tokio::test]
async fn retiring_concedes_and_the_fee_is_the_one_at_open() {
    let mut env = Env::ready().await;
    let t = env.live(21).await;
    let authority = clone(&env.authority);
    assert_eq!(env.update(&authority, ConfigUpdate { fee_bps: Some(0), ..Default::default() }).await, None);
    let (b0, f0) = (env.balance(env.b.pubkey()).await, env.balance(env.fee).await);
    let a = clone(&env.a);
    assert_eq!(env.play(&a, &t.series_id, WagerInstruction::Retire).await, None);
    assert_eq!(env.settle(&t.series_id).await, None);
    let fee = 2 * STAKE * FEE_BPS as u64 / 10_000;
    assert_eq!(env.balance(env.b.pubkey()).await, b0 + 2 * STAKE - fee);
    assert_eq!(env.balance(env.fee).await, f0 + fee);
}

#[tokio::test]
async fn a_drawn_series_refunds_both_in_full() {
    let mut env = Env::ready().await;
    let t = env.live(22).await;
    let id = t.series_id;
    let (a0, b0, f0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await, env.balance(env.fee).await);
    let rent = env.rent().await;
    let (a, b) = (clone(&env.a), clone(&env.b));
    // Every match: both commit, neither reveals, so each is void.
    let mut now = T0;
    for _ in 0..5 {
        let s = env.series(&id).await.unwrap().series.unwrap();
        if s.ending.is_some() {
            break;
        }
        let r = s.game.rounds + 1;
        assert_eq!(env.play(&a, &id, WagerInstruction::Commit { round: r, hash: [1; 32] }).await, None);
        assert_eq!(env.play(&b, &id, WagerInstruction::Commit { round: r, hash: [2; 32] }).await, None);
        assert_eq!(env.timeout(&id).await, Some((0, code(WagerError::Series) + 6)), "StillOpen");
        now += 121;
        env.set_time(now).await;
        assert_eq!(env.timeout(&id).await, None);
    }
    let s = env.series(&id).await.unwrap().series.unwrap();
    assert_eq!(s.ending.map(|e| e.winner), Some(None));
    assert_eq!(env.settle(&id).await, None);
    assert_eq!(env.balance(a.pubkey()).await, a0 + STAKE + rent);
    assert_eq!(env.balance(b.pubkey()).await, b0 + STAKE);
    assert_eq!(env.balance(env.fee).await, f0, "no fee on a draw");
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn series_rule_errors_come_back_with_their_own_codes() {
    let mut env = Env::ready().await;
    let t = env.live(23).await;
    let a = clone(&env.a);
    let series = |n: u32| Some((0, code(WagerError::Series) + n));
    assert_eq!(env.play(&a, &t.series_id, WagerInstruction::Commit { round: 2, hash: [0; 32] }).await, series(2), "WrongRound");
    assert_eq!(env.play(&a, &t.series_id, WagerInstruction::Reveal { pull: 0, nonce: [0; 32] }).await, series(1), "WrongPhase");
    env.set_time(T0 - 1).await;
    assert_eq!(env.play(&a, &t.series_id, WagerInstruction::Commit { round: 1, hash: [0; 32] }).await, series(14), "ClockBackward");
}

// ---------------------------------------------------------------- refunds

#[tokio::test]
async fn emergency_refund_after_a_day_idle_but_never_of_a_decided_series() {
    let mut env = Env::ready().await;
    let t = env.live(30).await;
    let (a0, b0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await);
    let rent = env.rent().await;
    env.set_time(T0 + EMERGENCY_AFTER_SECONDS - 1).await;
    assert_eq!(env.emergency(&t.series_id).await, Some((0, code(WagerError::NotYet))));
    env.set_time(T0 + EMERGENCY_AFTER_SECONDS).await;
    assert_eq!(env.emergency(&t.series_id).await, None);
    assert_eq!(env.balance(env.a.pubkey()).await, a0 + STAKE + rent);
    assert_eq!(env.balance(env.b.pubkey()).await, b0 + STAKE);
    assert_eq!(env.config().await.open_stake, 0);

    // Decided and left unsettled for a day: the loser can't take its stake back; it still settles.
    env.set_time(T0).await;
    let t = env.live(31).await;
    let b = clone(&env.b);
    assert_eq!(env.play(&b, &t.series_id, WagerInstruction::Retire).await, None);
    env.set_time(T0 + 2 * EMERGENCY_AFTER_SECONDS).await;
    assert_eq!(env.emergency(&t.series_id).await, Some((0, code(WagerError::Decided))));
    assert_eq!(env.settle(&t.series_id).await, None);
}

#[tokio::test]
async fn an_open_series_refunds_a_only_after_a_day() {
    let mut env = Env::ready().await;
    let t = env.ticket([32; 32]);
    assert_eq!(env.open(&t).await, None);
    let (a0, b0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await);
    let rent = env.rent().await;
    env.set_time(T0 + EMERGENCY_AFTER_SECONDS).await;
    assert_eq!(env.emergency(&t.series_id).await, None);
    assert_eq!(env.balance(env.a.pubkey()).await, a0 + STAKE + rent);
    assert_eq!(env.balance(env.b.pubkey()).await, b0);
}

#[tokio::test]
async fn freeze_and_refund_is_the_authoritys_alone() {
    let mut env = Env::ready().await;
    let t = env.live(33).await;
    let (a0, b0) = (env.balance(env.a.pubkey()).await, env.balance(env.b.pubkey()).await);
    let rent = env.rent().await;
    let (stranger, a, authority) = (clone(&env.stranger), clone(&env.a), clone(&env.authority));
    assert_eq!(env.freeze(&stranger, &t.series_id).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.freeze(&a, &t.series_id).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.freeze(&authority, &t.series_id).await, None);
    assert_eq!(env.balance(env.a.pubkey()).await, a0 + STAKE + rent);
    assert_eq!(env.balance(env.b.pubkey()).await, b0 + STAKE);
    assert!(env.series(&t.series_id).await.is_none());
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn refunds_go_only_to_the_two_players() {
    let mut env = Env::ready().await;
    let t = env.live(34).await;
    env.set_time(T0 + EMERGENCY_AFTER_SECONDS).await;
    let mut accounts = env.payout_accounts(&t.series_id, env.fee);
    accounts.pop();
    accounts[3] = AccountMeta::new(env.stranger.pubkey(), false);
    assert_eq!(env.send(vec![ix(WagerInstruction::EmergencyRefund, accounts)], &[]).await, Some((0, code(WagerError::WrongPayee))));
}
