//! The program end to end under solana-program-test: every instruction, with real Ed25519 tickets and results and real
//! lamports. `npm run test:link-program` runs these twice: natively, then (with SBF_OUT_DIR) against the built .so.

use borsh::BorshDeserialize;
use link_wager::error::WagerError;
use link_wager::instruction::{ConfigInit, ConfigUpdate, LinkWagerInstruction};
use link_wager::processor::battle_address;
use link_wager::signed::{BattleResult, Ticket};
use link_wager::state::{Battle, Config, CONFIG_SEED, OUTCOME_A, OUTCOME_B, OUTCOME_DRAW, OUTCOME_VOID, REFUND_AFTER_MIN, STATUS_LIVE, STATUS_OPEN, TICKET_LIFETIME_MAX};
use solana_program_test::{processor, BanksClientError, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable,
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    ed25519_instruction::new_ed25519_instruction,
    incinerator,
    instruction::{AccountMeta, Instruction, InstructionError},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program, sysvar,
    transaction::{Transaction, TransactionError},
};

const SOL: u64 = 1_000_000_000;
const T0: i64 = 1_800_000_000;
const STAKE: u64 = SOL / 10;
const REFUND_AFTER: u32 = 2 * 60 * 60;
/// How long the tests' tickets run.
const TICKET: i64 = 300;

fn program_id() -> Pubkey {
    link_wager::id()
}

fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &program_id()).0
}

fn key(seed: u8) -> ed25519_dalek::Keypair {
    let secret = ed25519_dalek::SecretKey::from_bytes(&[seed; 32]).unwrap();
    let public = ed25519_dalek::PublicKey::from(&secret);
    ed25519_dalek::Keypair { secret, public }
}

fn pubkey_of(k: &ed25519_dalek::Keypair) -> Pubkey {
    Pubkey::new_from_array(k.public.to_bytes())
}

fn clone(k: &Keypair) -> Keypair {
    Keypair::from_bytes(&k.to_bytes()).unwrap()
}

fn ix(data: LinkWagerInstruction, accounts: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: program_id(), accounts, data: borsh::to_vec(&data).unwrap() }
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

struct Env {
    ctx: ProgramTestContext,
    authority: Keypair,
    ticket_key: ed25519_dalek::Keypair,
    result_key: ed25519_dalek::Keypair,
    a: Keypair,
    b: Keypair,
    stranger: Keypair,
    nonce: u32,
    /// The clock, as last set.
    now: i64,
}

impl Env {
    /// A test validator with the program, a fake program-data account naming `authority` as upgrade authority, and
    /// funded wallets. The clock is at T0.
    async fn new() -> Env {
        let mut pt = ProgramTest::new("link_wager", program_id(), processor!(link_wager::processor::process));
        let authority = Keypair::new();
        let (a, b, stranger) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&authority, &a, &b, &stranger] {
            pt.add_account(k.pubkey(), Account { lamports: 100 * SOL, owner: system_program::ID, ..Account::default() });
        }
        let pd = Pubkey::find_program_address(&[program_id().as_ref()], &bpf_loader_upgradeable::ID).0;
        let mut data = vec![3, 0, 0, 0];
        data.extend_from_slice(&42u64.to_le_bytes());
        data.push(1);
        data.extend_from_slice(authority.pubkey().as_ref());
        pt.add_account(pd, Account { lamports: SOL, data, owner: bpf_loader_upgradeable::ID, ..Account::default() });
        let ctx = pt.start_with_context().await;
        let mut env = Env { ctx, authority, ticket_key: key(7), result_key: key(9), a, b, stranger, nonce: 0, now: T0 };
        env.set_time(T0).await;
        env
    }

    fn init(&self) -> ConfigInit {
        ConfigInit {
            authority: self.authority.pubkey(),
            ticket_key: pubkey_of(&self.ticket_key),
            ticket_key_id: 1,
            result_key: pubkey_of(&self.result_key),
            result_key_id: 1,
            tiers: [SOL / 100, STAKE, SOL, 0],
            max_stake: SOL,
            open_stake_cap: 3 * SOL,
            refund_after_seconds: REFUND_AFTER,
        }
    }

    async fn ready() -> Env {
        let mut env = Env::new().await;
        let init = env.init();
        let authority = clone(&env.authority);
        assert_eq!(env.init_config(&authority, init).await, None);
        env
    }

    async fn set_time(&mut self, t: i64) {
        let mut clock: Clock = self.ctx.banks_client.get_sysvar().await.unwrap();
        clock.unix_timestamp = t;
        self.ctx.set_sysvar(&clock);
        self.now = t;
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

    /// Whether `ixs` are refused, for whatever reason (the runtime's own refusals included).
    async fn fails(&mut self, mut ixs: Vec<Instruction>, signers: &[&Keypair]) -> bool {
        self.nonce += 1;
        ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(1_400_000 - self.nonce));
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&self.ctx.payer.pubkey()), &all, self.ctx.last_blockhash);
        self.ctx.banks_client.process_transaction(tx).await.is_err()
    }

    /// Sends `ixs` and returns the log of a successful transaction.
    async fn logs(&mut self, mut ixs: Vec<Instruction>, signers: &[&Keypair]) -> Vec<String> {
        self.nonce += 1;
        ixs.push(ComputeBudgetInstruction::set_compute_unit_limit(1_400_000 - self.nonce));
        let mut all: Vec<&Keypair> = vec![&self.ctx.payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&self.ctx.payer.pubkey()), &all, self.ctx.last_blockhash);
        let r = self.ctx.banks_client.process_transaction_with_metadata(tx).await.unwrap();
        assert!(r.result.is_ok(), "{:?}", r.result);
        r.metadata.unwrap().log_messages
    }

    async fn init_config(&mut self, payer: &Keypair, init: ConfigInit) -> Option<Failure> {
        let pd = Pubkey::find_program_address(&[program_id().as_ref()], &bpf_loader_upgradeable::ID).0;
        let i = ix(
            LinkWagerInstruction::InitConfig(init),
            vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config_address(), false), AccountMeta::new_readonly(pd, false), AccountMeta::new_readonly(system_program::ID, false)],
        );
        self.send(vec![i], &[payer]).await
    }

    async fn update(&mut self, signer: &Keypair, u: ConfigUpdate) -> Option<Failure> {
        let i = ix(LinkWagerInstruction::UpdateConfig(u), vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(config_address(), false)]);
        self.send(vec![i], &[signer]).await
    }

    /// Hands the config to `to`, which signs as well (or doesn't, with `signs` false).
    async fn hand_over(&mut self, signer: &Keypair, to: &Keypair, signs: bool) -> Option<Failure> {
        let u = ConfigUpdate { authority: Some(to.pubkey()), ..ConfigUpdate::default() };
        let i = ix(LinkWagerInstruction::UpdateConfig(u), vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(config_address(), false), AccountMeta::new_readonly(to.pubkey(), signs)]);
        if signs {
            self.send(vec![i], &[signer, to]).await
        } else {
            self.send(vec![i], &[signer]).await
        }
    }

    /// A ticket from now: B may accept for five minutes, and it expires then too (as the desk signs them).
    fn ticket(&self, id: [u8; 32]) -> Ticket {
        Ticket { battle_id: id, player_a: self.a.pubkey(), player_b: self.b.pubkey(), stake: STAKE, accept_deadline: self.now + TICKET, expiry: self.now + TICKET, key_id: 1 }
    }

    /// Moves the clock to just past a ticket's expiry: from then its battle may close.
    async fn past(&mut self, t: &Ticket) {
        if self.now <= t.expiry {
            self.set_time(t.expiry + 1).await;
        }
    }

    fn signed_ticket(&self, t: &Ticket) -> Instruction {
        new_ed25519_instruction(&self.ticket_key, &t.message(&program_id()))
    }

    fn open_ix(&self, t: &Ticket) -> Instruction {
        ix(
            LinkWagerInstruction::Open { battle_id: t.battle_id, player_b: t.player_b, stake: t.stake, accept_deadline: t.accept_deadline, expiry: t.expiry, key_id: t.key_id },
            vec![
                AccountMeta::new(t.player_a, true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    fn accept_ix(&self, t: &Ticket, signer: &Pubkey) -> Instruction {
        ix(
            LinkWagerInstruction::Accept,
            vec![
                AccountMeta::new(*signer, true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
        )
    }

    async fn open(&mut self, t: &Ticket) -> Option<Failure> {
        let ixs = vec![self.signed_ticket(t), self.open_ix(t)];
        let a = clone(&self.a);
        self.send(ixs, &[&a]).await
    }

    async fn accept(&mut self, t: &Ticket) -> Option<Failure> {
        let ixs = vec![self.signed_ticket(t), self.accept_ix(t, &t.player_b)];
        let b = clone(&self.b);
        self.send(ixs, &[&b]).await
    }

    /// Both stake at the current time, and the clock moves past the ticket's expiry (a battle outlasts its ticket);
    /// returns the ticket.
    async fn live(&mut self, seed: u8) -> Ticket {
        let t = self.ticket([seed; 32]);
        assert_eq!(self.open(&t).await, None);
        assert_eq!(self.accept(&t).await, None);
        self.past(&t).await;
        t
    }

    fn result(&self, t: &Ticket, outcome: u8) -> BattleResult {
        BattleResult { battle_id: t.battle_id, player_a: t.player_a, player_b: t.player_b, outcome, key_id: 1 }
    }

    fn signed_result(&self, r: &BattleResult) -> Instruction {
        new_ed25519_instruction(&self.result_key, &r.message(&program_id()))
    }

    fn settle_ix(&self, t: &Ticket, outcome: u8, key_id: u16) -> Instruction {
        ix(
            LinkWagerInstruction::Settle { outcome, key_id },
            vec![
                AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(t.player_a, false),
                AccountMeta::new(t.player_b, false),
                AccountMeta::new_readonly(sysvar::instructions::ID, false),
                AccountMeta::new(incinerator::ID, false),
            ],
        )
    }

    /// Anyone settles with the referee's signed result.
    async fn settle(&mut self, t: &Ticket, outcome: u8) -> Option<Failure> {
        let r = self.result(t, outcome);
        let ixs = vec![self.signed_result(&r), self.settle_ix(t, outcome, 1)];
        self.send(ixs, &[]).await
    }

    fn payout_accounts(&self, t: &Ticket) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
            AccountMeta::new(config_address(), false),
            AccountMeta::new(t.player_a, false),
            AccountMeta::new(t.player_b, false),
            AccountMeta::new(incinerator::ID, false),
        ]
    }

    async fn refund(&mut self, t: &Ticket) -> Option<Failure> {
        let i = ix(LinkWagerInstruction::Refund, self.payout_accounts(t));
        self.send(vec![i], &[]).await
    }

    async fn freeze(&mut self, signer: &Keypair, t: &Ticket) -> Option<Failure> {
        let i = ix(
            LinkWagerInstruction::FreezeAndRefund,
            vec![
                AccountMeta::new_readonly(signer.pubkey(), true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
                AccountMeta::new(t.player_a, false),
                AccountMeta::new(t.player_b, false),
                AccountMeta::new(incinerator::ID, false),
            ],
        );
        self.send(vec![i], &[signer]).await
    }

    async fn cancel(&mut self, caller: &Keypair, t: &Ticket) -> Option<Failure> {
        let i = ix(
            LinkWagerInstruction::Cancel,
            vec![
                AccountMeta::new_readonly(caller.pubkey(), true),
                AccountMeta::new(config_address(), false),
                AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
                AccountMeta::new(t.player_a, false),
                AccountMeta::new(incinerator::ID, false),
            ],
        );
        self.send(vec![i], &[caller]).await
    }

    async fn balance(&mut self, k: &Pubkey) -> u64 {
        self.ctx.banks_client.get_balance(*k).await.unwrap()
    }

    async fn config(&mut self) -> Config {
        let acc = self.ctx.banks_client.get_account(config_address()).await.unwrap().unwrap();
        Config::deserialize(&mut &acc.data[..]).unwrap()
    }

    async fn battle(&mut self, id: &[u8; 32]) -> Option<Battle> {
        let acc = self.ctx.banks_client.get_account(battle_address(&program_id(), id).0).await.unwrap()?;
        if acc.owner != program_id() {
            return None;
        }
        Some(Battle::deserialize(&mut &acc.data[..]).unwrap())
    }
}

// ---------------------------------------------------------------- config

#[tokio::test]
async fn only_the_upgrade_authority_sets_the_config_up_and_only_once() {
    let mut env = Env::new().await;
    let init = env.init();
    let stranger = clone(&env.stranger);
    assert_eq!(env.init_config(&stranger, init.clone()).await, Some((0, code(WagerError::NotAuthority))));
    let authority = clone(&env.authority);
    assert_eq!(env.init_config(&authority, init.clone()).await, None);
    assert_eq!(env.init_config(&authority, init).await, Some((0, code(WagerError::AlreadyInitialised))));
    let c = env.config().await;
    assert_eq!((c.version, c.paused, c.open_stake, c.refund_after_seconds), (1, false, 0, REFUND_AFTER));
    assert_eq!(c.result_key, pubkey_of(&env.result_key));
}

#[tokio::test]
async fn the_config_keeps_to_its_hard_limits() {
    let mut env = Env::new().await;
    let authority = clone(&env.authority);
    let mut init = env.init();
    init.refund_after_seconds = REFUND_AFTER_MIN - 1;
    assert_eq!(env.init_config(&authority, init).await, Some((0, code(WagerError::BadInstruction))));
    let mut init = env.init();
    init.tiers = [1, 0, 0, 0];
    assert_eq!(env.init_config(&authority, init).await, Some((0, code(WagerError::OverStakeCap))));
    let init = env.init();
    assert_eq!(env.init_config(&authority, init).await, None);
    // An update is held to the same limits, and only the authority may make one.
    assert_eq!(env.update(&authority, ConfigUpdate { max_stake: Some(11 * SOL), ..Default::default() }).await, Some((0, code(WagerError::OverStakeCap))));
    assert_eq!(env.update(&authority, ConfigUpdate { refund_after_seconds: Some(60), ..Default::default() }).await, Some((0, code(WagerError::BadInstruction))));
    let stranger = clone(&env.stranger);
    assert_eq!(env.update(&stranger, ConfigUpdate { paused: Some(true), ..Default::default() }).await, Some((0, code(WagerError::NotAuthority))));
}

// ---------------------------------------------------------------- staking

#[tokio::test]
async fn both_stake_from_the_desks_ticket_and_the_battle_is_live() {
    let mut env = Env::ready().await;
    let (a, b) = (env.a.pubkey(), env.b.pubkey());
    let (a0, b0) = (env.balance(&a).await, env.balance(&b).await);
    let t = env.ticket([1; 32]);
    assert_eq!(env.open(&t).await, None);
    let open = env.battle(&t.battle_id).await.unwrap();
    assert_eq!((open.status, open.stake, open.opened_at, open.live_at), (STATUS_OPEN, STAKE, T0, 0));
    // Both stakes are counted against the cap from the open.
    assert_eq!(env.config().await.open_stake, 2 * STAKE);
    env.set_time(T0 + 10).await;
    assert_eq!(env.accept(&t).await, None);
    let live = env.battle(&t.battle_id).await.unwrap();
    assert_eq!((live.status, live.live_at, live.player_a, live.player_b), (STATUS_LIVE, T0 + 10, a, b));
    // A paid its stake and the account's rent; B its stake alone.
    assert!(a0 - env.balance(&a).await > STAKE);
    assert_eq!(b0 - env.balance(&b).await, STAKE);
}

#[tokio::test]
async fn a_ticket_is_the_desks_for_this_program_these_wallets_and_this_stake() {
    let mut env = Env::ready().await;
    let t = env.ticket([2; 32]);
    let a = clone(&env.a);
    // No ticket at all.
    assert_eq!(env.send(vec![env.open_ix(&t)], &[&a]).await, Some((0, code(WagerError::BadTicket))));
    // Signed by another key.
    let forged = new_ed25519_instruction(&key(8), &t.message(&program_id()));
    assert_eq!(env.send(vec![forged, env.open_ix(&t)], &[&a]).await, Some((1, code(WagerError::BadTicket))));
    // The desk's ticket for another program (another deployment sharing the key).
    let other = new_ed25519_instruction(&env.ticket_key, &t.message(&Pubkey::new_unique()));
    assert_eq!(env.send(vec![other, env.open_ix(&t)], &[&a]).await, Some((1, code(WagerError::BadTicket))));
    // The desk's ticket for a smaller stake, used to open at a larger one.
    let cheap = Ticket { stake: SOL / 100, ..t };
    assert_eq!(env.send(vec![env.signed_ticket(&cheap), env.open_ix(&t)], &[&a]).await, Some((1, code(WagerError::BadTicket))));
    // The referee's result key can't sign a pairing, nor a result's message stand in for a ticket's.
    let wrong_key = new_ed25519_instruction(&env.result_key, &t.message(&program_id()));
    assert_eq!(env.send(vec![wrong_key, env.open_ix(&t)], &[&a]).await, Some((1, code(WagerError::BadTicket))));
    // Not placed just before the open.
    let pad = ComputeBudgetInstruction::set_compute_unit_price(1);
    assert_eq!(env.send(vec![env.signed_ticket(&t), pad, env.open_ix(&t)], &[&a]).await, Some((2, code(WagerError::BadTicket))));
    // The stranger can't open A's battle, and B can't be A.
    let stranger = clone(&env.stranger);
    let mine = Ticket { player_a: stranger.pubkey(), ..t };
    assert_eq!(env.send(vec![env.signed_ticket(&t), env.open_ix(&mine)], &[&stranger]).await, Some((1, code(WagerError::BadTicket))));
    // The real one works, once.
    assert_eq!(env.open(&t).await, None);
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::WrongStatus))));
}

#[tokio::test]
async fn a_stake_is_a_tier_under_the_caps_and_the_ticket_is_in_time() {
    let mut env = Env::ready().await;
    let a = clone(&env.a);
    let odd = Ticket { stake: STAKE + 1, ..env.ticket([3; 32]) };
    assert_eq!(env.send(vec![env.signed_ticket(&odd), env.open_ix(&odd)], &[&a]).await, Some((1, code(WagerError::BadTier))));
    // The cap on all open stakes: 3 SOL holds one battle at the 1 SOL tier, not two.
    let big = Ticket { stake: SOL, ..env.ticket([4; 32]) };
    assert_eq!(env.send(vec![env.signed_ticket(&big), env.open_ix(&big)], &[&a]).await, None);
    let second = Ticket { stake: SOL, ..env.ticket([5; 32]) };
    assert_eq!(env.send(vec![env.signed_ticket(&second), env.open_ix(&second)], &[&a]).await, Some((1, code(WagerError::OverOpenStakeCap))));
    // A ticket past its expiry, and one whose key id isn't the config's.
    let t = env.ticket([6; 32]);
    env.set_time(T0 + 601).await;
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::TicketExpired))));
    env.set_time(T0).await;
    let old = Ticket { key_id: 2, ..t };
    assert_eq!(env.send(vec![env.signed_ticket(&old), env.open_ix(&old)], &[&a]).await, Some((1, code(WagerError::TicketExpired))));
}

#[tokio::test]
async fn a_paused_config_takes_no_new_stakes() {
    let mut env = Env::ready().await;
    let authority = clone(&env.authority);
    let t = env.ticket([7; 32]);
    assert_eq!(env.open(&t).await, None);
    assert_eq!(env.update(&authority, ConfigUpdate { paused: Some(true), ..Default::default() }).await, None);
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::Paused))));
    let other = env.ticket([8; 32]);
    assert_eq!(env.open(&other).await, Some((1, code(WagerError::Paused))));
    // What's already staked can still leave: cancelled once its ticket has run out.
    let a = clone(&env.a);
    env.past(&t).await;
    assert_eq!(env.cancel(&a, &t).await, None);
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn only_b_accepts_and_only_in_time() {
    let mut env = Env::ready().await;
    let t = env.ticket([9; 32]);
    assert_eq!(env.open(&t).await, None);
    let stranger = clone(&env.stranger);
    let ixs = vec![env.signed_ticket(&t), env.accept_ix(&t, &stranger.pubkey())];
    assert_eq!(env.send(ixs, &[&stranger]).await, Some((1, code(WagerError::NotAPlayer))));
    env.set_time(T0 + 301).await;
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::AcceptDeadlinePassed))));
    env.set_time(T0 + 300).await;
    assert_eq!(env.accept(&t).await, None);
    assert_eq!(env.accept(&t).await, Some((1, code(WagerError::WrongStatus))));
}

#[tokio::test]
async fn a_battle_b_never_joins_is_cancelled_and_a_gets_everything_back() {
    let mut env = Env::ready().await;
    let a_key = env.a.pubkey();
    let a0 = env.balance(&a_key).await;
    let t = env.ticket([10; 32]);
    assert_eq!(env.open(&t).await, None);
    // Nobody cancels while the ticket runs, A included: a cancel then would let the same ticket open it again.
    let stranger = clone(&env.stranger);
    let a = clone(&env.a);
    assert_eq!(env.cancel(&stranger, &t).await, Some((0, code(WagerError::NotYet))));
    assert_eq!(env.cancel(&a, &t).await, Some((0, code(WagerError::NotYet))));
    env.set_time(t.expiry).await;
    assert_eq!(env.cancel(&a, &t).await, Some((0, code(WagerError::NotYet))));
    // Once it has run out, anyone can, and everything goes back to A.
    env.past(&t).await;
    assert_eq!(env.cancel(&stranger, &t).await, None);
    assert_eq!(env.balance(&a_key).await, a0);
    assert_eq!(env.battle(&t.battle_id).await, None);
    assert_eq!(env.config().await.open_stake, 0);
    // A live battle isn't cancelled.
    let t = env.live(12).await;
    assert_eq!(env.cancel(&a, &t).await, Some((0, code(WagerError::WrongStatus))));
}

#[tokio::test]
async fn a_ticket_opens_one_battle_ever_and_a_result_settles_one() {
    // Cancelled: the same ticket can't open the battle again.
    let mut env = Env::ready().await;
    let a = clone(&env.a);
    let t = env.ticket([13; 32]);
    assert_eq!(env.open(&t).await, None);
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::WrongStatus))), "not twice while it's open");
    env.past(&t).await;
    assert_eq!(env.cancel(&a, &t).await, None);
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::TicketExpired))));
    // Settled: a battle isn't paid while its ticket still runs, so there's never a closed battle the ticket could
    // open again for the same (public) result to settle a second time.
    let mut env = Env::ready().await;
    let (ak, bk) = (env.a.pubkey(), env.b.pubkey());
    let (a0, b0) = (env.balance(&ak).await, env.balance(&bk).await);
    let t = env.ticket([14; 32]);
    assert_eq!(env.open(&t).await, None);
    assert_eq!(env.accept(&t).await, None);
    assert_eq!(env.settle(&t, OUTCOME_A).await, Some((1, code(WagerError::NotYet))));
    let authority = clone(&env.authority);
    assert_eq!(env.freeze(&authority, &t).await, Some((0, code(WagerError::NotYet))), "nor frozen, even by the authority");
    env.past(&t).await;
    assert_eq!(env.settle(&t, OUTCOME_A).await, None);
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::TicketExpired))));
    assert_eq!(env.settle(&t, OUTCOME_A).await, Some((1, code(WagerError::WrongBattleAccount))));
    assert_eq!((env.balance(&ak).await, env.balance(&bk).await), (a0 + STAKE, b0 - STAKE), "paid once");
}

#[tokio::test]
async fn a_ticket_runs_fifteen_minutes_at_most() {
    let mut env = Env::ready().await;
    let a = clone(&env.a);
    let long = Ticket { accept_deadline: T0 + 60, expiry: T0 + TICKET_LIFETIME_MAX + 1, ..env.ticket([15; 32]) };
    assert_eq!(env.send(vec![env.signed_ticket(&long), env.open_ix(&long)], &[&a]).await, Some((1, code(WagerError::TicketExpired))));
    let most = Ticket { accept_deadline: T0 + 60, expiry: T0 + TICKET_LIFETIME_MAX, ..env.ticket([16; 32]) };
    assert_eq!(env.send(vec![env.signed_ticket(&most), env.open_ix(&most)], &[&a]).await, None);
}

// ---------------------------------------------------------------- the end

#[tokio::test]
async fn the_referees_result_pays_the_winner_both_stakes() {
    for (outcome, a_gain, b_gain) in [(OUTCOME_A, STAKE as i64, -(STAKE as i64)), (OUTCOME_B, -(STAKE as i64), STAKE as i64), (OUTCOME_DRAW, 0, 0), (OUTCOME_VOID, 0, 0)] {
        let mut env = Env::ready().await;
        let (a, b) = (env.a.pubkey(), env.b.pubkey());
        let (a0, b0) = (env.balance(&a).await, env.balance(&b).await);
        let t = env.live(20 + outcome).await;
        assert_eq!(env.settle(&t, outcome).await, None);
        // Stakes moved as the result says; A's rent came back with the close.
        assert_eq!(env.balance(&a).await as i64 - a0 as i64, a_gain, "outcome {outcome}");
        assert_eq!(env.balance(&b).await as i64 - b0 as i64, b_gain, "outcome {outcome}");
        assert_eq!(env.battle(&t.battle_id).await, None);
        assert_eq!(env.config().await.open_stake, 0);
        // Settled once: the account is gone.
        assert_eq!(env.settle(&t, outcome).await, Some((1, code(WagerError::WrongBattleAccount))));
    }
}

/// The `Program data:` line a closing announces: "link-wager", the kind, the battle's id, the outcome, each base64.
fn event(kind: u8, id: &[u8; 32], outcome: u8) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let enc = |b: &[u8]| {
        let mut out = String::new();
        for c in b.chunks(3) {
            let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
            for i in 0..4 {
                out.push(if i <= c.len() { B64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
            }
        }
        out
    };
    format!("Program data: {} {} {} {}", enc(b"link-wager"), enc(&[kind]), enc(id), enc(&[outcome]))
}

#[tokio::test]
async fn every_closing_announces_how_the_battle_ended() {
    // Logs are captured only when the built program runs: natively, `sol_log_data` goes to stdout.
    if std::env::var("SBF_OUT_DIR").is_err() {
        return;
    }
    let mut env = Env::ready().await;
    // A settle to B.
    let t = env.live(30).await;
    let r = env.result(&t, OUTCOME_B);
    let logs = env.logs(vec![env.signed_result(&r), env.settle_ix(&t, OUTCOME_B, 1)], &[]).await;
    assert!(logs.contains(&event(1, &t.battle_id, OUTCOME_B)), "{logs:#?}");
    // A cancel.
    let t = env.ticket([35; 32]);
    assert_eq!(env.open(&t).await, None);
    let a = clone(&env.a);
    let cancel = ix(
        LinkWagerInstruction::Cancel,
        vec![
            AccountMeta::new_readonly(a.pubkey(), true),
            AccountMeta::new(config_address(), false),
            AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false),
            AccountMeta::new(t.player_a, false),
            AccountMeta::new(incinerator::ID, false),
        ],
    );
    let logs = env.logs(vec![cancel], &[&a]).await;
    assert!(logs.contains(&event(2, &t.battle_id, 255)), "{logs:#?}");
    // A refund.
    let t = env.live(36).await;
    env.set_time(T0 + REFUND_AFTER as i64).await;
    let logs = env.logs(vec![ix(LinkWagerInstruction::Refund, env.payout_accounts(&t))], &[]).await;
    assert!(logs.contains(&event(3, &t.battle_id, 255)), "{logs:#?}");
}

#[tokio::test]
async fn a_result_is_the_referees_for_this_battle_and_this_outcome() {
    let mut env = Env::ready().await;
    let t = env.live(31).await;
    let other = env.live(32).await;
    let r = env.result(&t, OUTCOME_A);
    // No result at all.
    assert_eq!(env.send(vec![env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((0, code(WagerError::BadResult))));
    // Signed by another key, or by the desk's ticket key.
    let forged = new_ed25519_instruction(&key(8), &r.message(&program_id()));
    assert_eq!(env.send(vec![forged, env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    let by_desk = new_ed25519_instruction(&env.ticket_key, &r.message(&program_id()));
    assert_eq!(env.send(vec![by_desk, env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    // The referee's result for another battle, another outcome, another program.
    assert_eq!(env.send(vec![env.signed_result(&r), env.settle_ix(&other, OUTCOME_A, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    assert_eq!(env.send(vec![env.signed_result(&r), env.settle_ix(&t, OUTCOME_B, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    let elsewhere = new_ed25519_instruction(&env.result_key, &r.message(&Pubkey::new_unique()));
    assert_eq!(env.send(vec![elsewhere, env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    // The desk's ticket can't stand in for a result.
    assert_eq!(env.send(vec![env.signed_ticket(&t), env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((1, code(WagerError::BadResult))));
    // Not placed just before the settle.
    let pad = ComputeBudgetInstruction::set_compute_unit_price(1);
    assert_eq!(env.send(vec![env.signed_result(&r), pad, env.settle_ix(&t, OUTCOME_A, 1)], &[]).await, Some((2, code(WagerError::BadResult))));
    // An outcome the program doesn't know, even signed.
    let odd = BattleResult { outcome: 4, ..r };
    assert_eq!(env.send(vec![env.signed_result(&odd), env.settle_ix(&t, 4, 1)], &[]).await, Some((1, code(WagerError::BadOutcome))));
    // Paid to someone else.
    let mut wrong = env.settle_ix(&t, OUTCOME_A, 1);
    wrong.accounts[2] = AccountMeta::new(env.stranger.pubkey(), false);
    assert_eq!(env.send(vec![env.signed_result(&r), wrong], &[]).await, Some((1, code(WagerError::WrongPayee))));
    // The stakes are all still there, and the real result settles it.
    assert_eq!(env.config().await.open_stake, 4 * STAKE);
    assert_eq!(env.settle(&t, OUTCOME_A).await, None);
}

#[tokio::test]
async fn a_result_under_a_rotated_key_is_signed_again() {
    let mut env = Env::ready().await;
    let t = env.live(33).await;
    let authority = clone(&env.authority);
    let fresh = key(11);
    assert_eq!(env.update(&authority, ConfigUpdate { result_key: Some((pubkey_of(&fresh), 2)), ..Default::default() }).await, None);
    // The old key's result, under either id, is refused.
    assert_eq!(env.settle(&t, OUTCOME_A).await, Some((1, code(WagerError::BadResult))));
    let r = env.result(&t, OUTCOME_A);
    assert_eq!(env.send(vec![env.signed_result(&r), env.settle_ix(&t, OUTCOME_A, 2)], &[]).await, Some((1, code(WagerError::BadResult))));
    // The new key's settles it.
    let r2 = BattleResult { key_id: 2, ..r };
    let signed = new_ed25519_instruction(&fresh, &r2.message(&program_id()));
    assert_eq!(env.send(vec![signed, env.settle_ix(&t, OUTCOME_A, 2)], &[]).await, None);
}

#[tokio::test]
async fn a_battle_only_a_has_staked_on_has_no_result() {
    let mut env = Env::ready().await;
    let t = env.ticket([34; 32]);
    assert_eq!(env.open(&t).await, None);
    assert_eq!(env.settle(&t, OUTCOME_A).await, Some((1, code(WagerError::WrongStatus))));
    assert_eq!(env.refund(&t).await, Some((0, code(WagerError::WrongStatus))));
}

#[tokio::test]
async fn with_no_result_anyone_refunds_both_after_the_deadline() {
    let mut env = Env::ready().await;
    let (a, b) = (env.a.pubkey(), env.b.pubkey());
    let (a0, b0) = (env.balance(&a).await, env.balance(&b).await);
    env.set_time(T0 + 5).await;
    let t = env.live(40).await;
    // Not while the battle may still be on.
    env.set_time(T0 + 5 + REFUND_AFTER as i64 - 1).await;
    assert_eq!(env.refund(&t).await, Some((0, code(WagerError::NotYet))));
    // The wrong payees are refused.
    env.set_time(T0 + 5 + REFUND_AFTER as i64).await;
    let mut wrong = env.payout_accounts(&t);
    wrong[3] = AccountMeta::new(env.stranger.pubkey(), false);
    assert_eq!(env.send(vec![ix(LinkWagerInstruction::Refund, wrong)], &[]).await, Some((0, code(WagerError::WrongPayee))));
    assert_eq!(env.refund(&t).await, None);
    assert_eq!((env.balance(&a).await, env.balance(&b).await), (a0, b0));
    assert_eq!(env.battle(&t.battle_id).await, None);
    assert_eq!(env.config().await.open_stake, 0);
    assert_eq!(env.refund(&t).await, Some((0, code(WagerError::WrongBattleAccount))));
}

#[tokio::test]
async fn the_refund_time_is_fixed_when_b_stakes() {
    let mut env = Env::ready().await;
    let authority = clone(&env.authority);
    let t = env.live(44).await;
    let b = env.battle(&t.battle_id).await.unwrap();
    assert_eq!(b.refund_at, b.live_at + REFUND_AFTER as i64);
    // The authority shortens the window: a battle already being played keeps the one it started with.
    assert_eq!(env.update(&authority, ConfigUpdate { refund_after_seconds: Some(REFUND_AFTER_MIN), ..Default::default() }).await, None);
    env.set_time(b.live_at + REFUND_AFTER_MIN as i64 + 1).await;
    assert_eq!(env.refund(&t).await, Some((0, code(WagerError::NotYet))));
    env.set_time(b.refund_at - 1).await;
    assert_eq!(env.refund(&t).await, Some((0, code(WagerError::NotYet))));
    env.set_time(b.refund_at).await;
    assert_eq!(env.refund(&t).await, None);
    // A battle staked after the change gets the new window.
    let t = env.live(45).await;
    let b = env.battle(&t.battle_id).await.unwrap();
    assert_eq!(b.refund_at, b.live_at + REFUND_AFTER_MIN as i64);
}

#[tokio::test]
async fn the_authority_alone_freezes_and_refunds_whoever_has_staked() {
    let mut env = Env::ready().await;
    let (a, b) = (env.a.pubkey(), env.b.pubkey());
    let (a0, b0) = (env.balance(&a).await, env.balance(&b).await);
    let authority = clone(&env.authority);
    let stranger = clone(&env.stranger);
    // Both staked.
    let t = env.live(41).await;
    assert_eq!(env.freeze(&stranger, &t).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.freeze(&authority, &t).await, None);
    assert_eq!((env.balance(&a).await, env.balance(&b).await), (a0, b0));
    // Only A staked: B is paid nothing, A gets its stake back.
    let t = env.ticket([42; 32]);
    assert_eq!(env.open(&t).await, None);
    env.past(&t).await;
    assert_eq!(env.freeze(&authority, &t).await, None);
    assert_eq!((env.balance(&a).await, env.balance(&b).await), (a0, b0));
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn a_payout_only_ever_burns_into_the_incinerator() {
    let mut env = Env::ready().await;
    let t = env.live(43).await;
    let r = env.result(&t, OUTCOME_A);
    let mut wrong = env.settle_ix(&t, OUTCOME_A, 1);
    wrong.accounts[5] = AccountMeta::new(env.stranger.pubkey(), false);
    assert_eq!(env.send(vec![env.signed_result(&r), wrong], &[]).await, Some((1, code(WagerError::NotIncinerator))));
}

#[tokio::test]
async fn the_open_stake_counter_comes_back_to_zero_on_every_way_out() {
    let mut env = Env::ready().await;
    let authority = clone(&env.authority);
    let a = clone(&env.a);
    // Settled, refunded, frozen, cancelled: four battles in turn, the counter at two stakes while each is open.
    let t = env.live(50).await;
    assert_eq!(env.config().await.open_stake, 2 * STAKE);
    assert_eq!(env.settle(&t, OUTCOME_DRAW).await, None);
    assert_eq!(env.config().await.open_stake, 0);
    let t = env.live(51).await;
    let at = env.battle(&t.battle_id).await.unwrap().refund_at;
    env.set_time(at).await;
    assert_eq!(env.refund(&t).await, None);
    assert_eq!(env.config().await.open_stake, 0);
    let t = env.live(52).await;
    assert_eq!(env.freeze(&authority, &t).await, None);
    assert_eq!(env.config().await.open_stake, 0);
    let t = env.ticket([53; 32]);
    assert_eq!(env.open(&t).await, None);
    env.past(&t).await;
    assert_eq!(env.cancel(&a, &t).await, None);
    assert_eq!(env.config().await.open_stake, 0);
}

// ---------------------------------------------------------------- attacks (from the review of 2026-11-15)

#[tokio::test]
async fn the_config_takes_three_real_keys_and_changes_hands_only_to_a_key_that_signs() {
    let mut env = Env::new().await;
    let authority = clone(&env.authority);
    // No key is all zeroes, and the two signing keys are never the same key.
    for bad in [
        ConfigInit { authority: Pubkey::default(), ..env.init() },
        ConfigInit { ticket_key: Pubkey::default(), ..env.init() },
        ConfigInit { result_key: Pubkey::default(), ..env.init() },
        ConfigInit { result_key: pubkey_of(&env.ticket_key), ..env.init() },
    ] {
        assert_eq!(env.init_config(&authority, bad).await, Some((0, code(WagerError::BadInstruction))));
    }
    let init = env.init();
    assert_eq!(env.init_config(&authority, init).await, None);
    let same = ConfigUpdate { result_key: Some((pubkey_of(&env.ticket_key), 2)), ..Default::default() };
    assert_eq!(env.update(&authority, same).await, Some((0, code(WagerError::BadInstruction))));
    let zero = ConfigUpdate { ticket_key: Some((Pubkey::default(), 2)), ..Default::default() };
    assert_eq!(env.update(&authority, zero).await, Some((0, code(WagerError::BadInstruction))));
    // The config is handed only to a key that signs for it: never to a mistyped address, or to nobody.
    let next = clone(&env.stranger);
    assert_eq!(env.hand_over(&authority, &next, false).await, Some((0, code(WagerError::NotAuthority))));
    let bare = ix(LinkWagerInstruction::UpdateConfig(ConfigUpdate { authority: Some(next.pubkey()), ..Default::default() }), vec![AccountMeta::new_readonly(authority.pubkey(), true), AccountMeta::new(config_address(), false)]);
    assert!(env.fails(vec![bare], &[&authority]).await, "nor with the new key left out");
    assert_eq!(env.config().await.authority, authority.pubkey());
    assert_eq!(env.hand_over(&authority, &next, true).await, None);
    assert_eq!(env.config().await.authority, next.pubkey());
    assert_eq!(env.update(&authority, ConfigUpdate { paused: Some(true), ..Default::default() }).await, Some((0, code(WagerError::NotAuthority))));
    assert_eq!(env.update(&next, ConfigUpdate { paused: Some(true), ..Default::default() }).await, None);
}

/// A hand-made Ed25519 instruction: `count` signature entries (one given), then `body`.
fn raw_ed25519(sig: (u16, u16), key: (u16, u16), msg: (u16, u16, u16), body: &[u8], count: u8) -> Instruction {
    let mut d = vec![count, 0];
    for v in [sig.0, sig.1, key.0, key.1, msg.0, msg.1, msg.2] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(body);
    Instruction { program_id: solana_sdk::ed25519_program::id(), accounts: vec![], data: d }
}

#[tokio::test]
async fn a_signature_check_that_points_at_another_instruction_is_no_ticket() {
    use ed25519_dalek::Signer as _;
    let mut env = Env::ready().await;
    let t = env.ticket([60; 32]);
    let a = clone(&env.a);
    let msg = t.message(&program_id());
    let len = msg.len() as u16;
    let attacker = key(99);
    let sig = attacker.sign(&msg).to_bytes();
    // Instruction 0 is an honest check of the ATTACKER's signature over the ticket. Instruction 1 carries the desk's
    // key and the message in its own bytes, and points the precompile at instruction 0's signature, key and message.
    let honest = new_ed25519_instruction(&attacker, &msg);
    let mut body = vec![];
    body.extend_from_slice(pubkey_of(&env.ticket_key).as_ref()); // at 16
    body.extend_from_slice(&sig); // at 48
    body.extend_from_slice(&msg); // at 112
    let pointing = raw_ed25519((48, 0), (16, 0), (112, len, 0), &body, 1);
    assert_eq!(env.send(vec![honest.clone(), pointing, env.open_ix(&t)], &[&a]).await, Some((2, code(WagerError::BadTicket))));
    // Any one of the three pointing elsewhere is refused.
    for (si, ki, mi) in [(0u16, u16::MAX, u16::MAX), (u16::MAX, 0, u16::MAX), (u16::MAX, u16::MAX, 0)] {
        let p = raw_ed25519((48, si), (16, ki), (112, len, mi), &body, 1);
        assert!(env.fails(vec![honest.clone(), p, env.open_ix(&t)], &[&a]).await);
    }
    // No signatures at all (the precompile then checks nothing), with the desk's key and the message sitting in the data.
    let none = raw_ed25519((48, u16::MAX), (16, u16::MAX), (112, len, u16::MAX), &body, 0);
    assert!(env.fails(vec![none, env.open_ix(&t)], &[&a]).await);
    // Two signatures in one check.
    let mut two = vec![2u8, 0];
    let base = 2 + 28u16;
    for _ in 0..2 {
        for v in [base + 32, u16::MAX, base, u16::MAX, base + 96, len, u16::MAX] {
            two.extend_from_slice(&v.to_le_bytes());
        }
    }
    two.extend_from_slice(&attacker.public.to_bytes());
    two.extend_from_slice(&sig);
    two.extend_from_slice(&msg);
    let two = Instruction { program_id: solana_sdk::ed25519_program::id(), accounts: vec![], data: two };
    assert!(env.fails(vec![two, env.open_ix(&t)], &[&a]).await);
    // The desk's real check, bytes and all, under another program's id.
    let fake = Instruction { program_id: system_program::ID, accounts: vec![], data: env.signed_ticket(&t).data };
    assert!(env.fails(vec![fake, env.open_ix(&t)], &[&a]).await);
    assert_eq!(env.battle(&t.battle_id).await, None, "nothing was opened");
}

fn make_program(env: &mut Env, who: Pubkey) {
    env.ctx.set_account(&who, &Account { lamports: 5 * SOL, data: vec![0; 36], owner: bpf_loader_upgradeable::ID, executable: true, rent_epoch: u64::MAX }.into());
}

#[tokio::test]
async fn a_player_who_becomes_a_program_cant_hold_up_the_others_money() {
    // A turns its wallet into a program after both staked. B wins: B is paid in full, and what was A's is burned.
    let mut env = Env::ready().await;
    let (a, b) = (env.a.pubkey(), env.b.pubkey());
    let b0 = env.balance(&b).await;
    let t = env.live(61).await;
    make_program(&mut env, a);
    let burnt0 = env.balance(&incinerator::ID).await;
    assert_eq!(env.settle(&t, OUTCOME_B).await, None);
    assert_eq!(env.balance(&b).await, b0 + STAKE);
    assert!(env.balance(&incinerator::ID).await > burnt0, "the battle account's rent, which was A's, is burned");
    // A draw: B's stake comes back whole.
    let mut env = Env::ready().await;
    let (a, b) = (env.a.pubkey(), env.b.pubkey());
    let b0 = env.balance(&b).await;
    let t = env.live(62).await;
    make_program(&mut env, a);
    assert_eq!(env.settle(&t, OUTCOME_DRAW).await, None);
    assert_eq!(env.balance(&b).await, b0);
    // B is the program: A is whole on a void, a refund and a freeze.
    for how in 0..3u8 {
        let mut env = Env::ready().await;
        let (a, b) = (env.a.pubkey(), env.b.pubkey());
        let a0 = env.balance(&a).await;
        let t = env.live(63 + how).await;
        make_program(&mut env, b);
        match how {
            0 => assert_eq!(env.settle(&t, OUTCOME_VOID).await, None),
            1 => {
                let at = env.battle(&t.battle_id).await.unwrap().refund_at;
                env.set_time(at).await;
                assert_eq!(env.refund(&t).await, None);
            }
            _ => {
                let authority = clone(&env.authority);
                assert_eq!(env.freeze(&authority, &t).await, None);
            }
        }
        assert_eq!(env.balance(&a).await, a0, "way out {how}");
        assert_eq!(env.config().await.open_stake, 0);
    }
    // And a program can't stake in the first place.
    let mut env = Env::ready().await;
    let a = env.a.pubkey();
    make_program(&mut env, a);
    let t = env.ticket([66; 32]);
    assert_eq!(env.open(&t).await, Some((1, code(WagerError::NotAPlayer))));
}

#[tokio::test]
async fn emptied_wallets_are_still_paid_and_a_funded_battle_address_still_opens() {
    // Both wallets emptied to nothing after staking: every outcome still settles.
    for outcome in [OUTCOME_A, OUTCOME_B, OUTCOME_DRAW, OUTCOME_VOID] {
        let mut env = Env::ready().await;
        let (a, b) = (env.a.pubkey(), env.b.pubkey());
        let t = env.live(70 + outcome).await;
        env.ctx.set_account(&a, &Account::default().into());
        env.ctx.set_account(&b, &Account::default().into());
        assert_eq!(env.settle(&t, outcome).await, None, "outcome {outcome}");
    }
    // Someone sends lamports to a battle's address before it opens: it opens all the same, and A gets them at the close.
    let mut env = Env::ready().await;
    let a = env.a.pubkey();
    let a0 = env.balance(&a).await;
    let stranger = clone(&env.stranger);
    let t = env.ticket([75; 32]);
    let at = battle_address(&program_id(), &t.battle_id).0;
    assert_eq!(env.send(vec![system_instruction::transfer(&stranger.pubkey(), &at, SOL)], &[&stranger]).await, None);
    assert_eq!(env.open(&t).await, None);
    env.past(&t).await;
    assert_eq!(env.cancel(&stranger, &t).await, None);
    assert_eq!(env.balance(&a).await, a0 + SOL);
    assert_eq!(env.config().await.open_stake, 0);
}

#[tokio::test]
async fn the_wrong_account_in_any_place_is_refused() {
    let mut env = Env::ready().await;
    let t = env.live(80).await;
    let r = env.result(&t, OUTCOME_A);
    let stranger = env.stranger.pubkey();
    let swaps: Vec<(usize, AccountMeta)> = vec![
        (3, AccountMeta::new(t.player_a, false)),             // A as both payees
        (2, AccountMeta::new(t.player_b, false)),             // B as both payees
        (0, AccountMeta::new(config_address(), false)),       // the config as the battle
        (1, AccountMeta::new(battle_address(&program_id(), &t.battle_id).0, false)), // the battle as the config
        (1, AccountMeta::new(stranger, false)),               // an account that isn't the config
        (4, AccountMeta::new_readonly(stranger, false)),      // not the instructions sysvar
    ];
    for (at, meta) in swaps {
        let mut i = env.settle_ix(&t, OUTCOME_A, 1);
        i.accounts[at] = meta;
        assert!(env.fails(vec![env.signed_result(&r), i], &[]).await, "settle with account {at} swapped");
    }
    // A refund and a cancel with an account that isn't the config.
    let at = env.battle(&t.battle_id).await.unwrap().refund_at;
    env.set_time(at).await;
    let mut acc = env.payout_accounts(&t);
    acc[1] = AccountMeta::new(stranger, false);
    assert!(env.fails(vec![ix(LinkWagerInstruction::Refund, acc)], &[]).await);
    let open = env.ticket([81; 32]);
    assert_eq!(env.open(&open).await, None);
    env.past(&open).await;
    let a = clone(&env.a);
    let i = ix(
        LinkWagerInstruction::Cancel,
        vec![AccountMeta::new_readonly(a.pubkey(), true), AccountMeta::new(stranger, false), AccountMeta::new(battle_address(&program_id(), &open.battle_id).0, false), AccountMeta::new(open.player_a, false), AccountMeta::new(incinerator::ID, false)],
    );
    assert!(env.fails(vec![i], &[&a]).await);
    assert_eq!(env.config().await.open_stake, 4 * STAKE, "both battles still hold their stakes");
}
