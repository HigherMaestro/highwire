//! Runs wager transactions built by the TypeScript codec in highwire-wager (`packages/wager/scripts/wager-instructions.ts`)
//! against the program: the builders' encodings and account orders, checked by the program itself rather than by a
//! second description of them. Keys come from the same fixed seeds on both sides. `npm run test:program` writes the
//! fixture first.

use borsh::BorshDeserialize;
use line_wager::instruction::{ConfigInit, WagerInstruction};
use line_wager::state::{Config, CONFIG_SEED};
use serde_json::Value;
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    signer::keypair::keypair_from_seed,
    system_program,
    transaction::Transaction,
};
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[tokio::test]
async fn transactions_built_by_the_typescript_run_on_the_program() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/ts-instructions.json");
    let text = std::fs::read_to_string(path).expect("no fixture: run `npm run test:program` (it writes it first)");
    let f: Value = serde_json::from_str(&text).unwrap();
    let program = Pubkey::from_str(f["program"].as_str().unwrap()).unwrap();
    assert_eq!(program, line_wager::id(), "the TypeScript's program id is the program's");

    let seed = |n: u8| keypair_from_seed(&[n; 32]).unwrap();
    let (a, b, fee, crank, authority) = (seed(1), seed(2), seed(3), seed(4), seed(5));
    let mut pt = ProgramTest::new("line_wager", program, processor!(line_wager::processor::process));
    for k in [&a, &b, &crank, &authority] {
        pt.add_account(k.pubkey(), Account { lamports: 10 * SOL, owner: system_program::ID, ..Account::default() });
    }
    pt.add_account(fee.pubkey(), Account { lamports: SOL, owner: system_program::ID, ..Account::default() });
    let pd = Pubkey::find_program_address(&[program.as_ref()], &bpf_loader_upgradeable::ID).0;
    let mut data = vec![3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    data.extend_from_slice(authority.pubkey().as_ref());
    pt.add_account(pd, Account { lamports: SOL, data, owner: bpf_loader_upgradeable::ID, ..Account::default() });
    let mut ctx = pt.start_with_context().await;

    let stake: u64 = f["stake"].as_str().unwrap().parse().unwrap();
    let config = Pubkey::find_program_address(&[CONFIG_SEED], &program).0;
    let init = WagerInstruction::InitConfig(ConfigInit {
        authority: authority.pubkey(),
        ticket_key: Pubkey::from_str(f["ticketKey"].as_str().unwrap()).unwrap(),
        ticket_key_id: 1,
        fee_bps: 250,
        fee_account: Pubkey::from_str(f["feeAccount"].as_str().unwrap()).unwrap(),
        tiers: [SOL / 100, stake, SOL, 0],
        max_stake: SOL,
        open_stake_cap: 10 * SOL,
        reveal_seconds: 120,
    });
    let ix = Instruction {
        program_id: program,
        accounts: vec![AccountMeta::new(authority.pubkey(), true), AccountMeta::new(config, false), AccountMeta::new_readonly(pd, false), AccountMeta::new_readonly(system_program::ID, false)],
        data: borsh::to_vec(&init).unwrap(),
    };
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &[&ctx.payer, &authority], ctx.last_blockhash);
    ctx.banks_client.process_transaction(tx).await.unwrap();

    let b0 = ctx.banks_client.get_balance(b.pubkey()).await.unwrap();
    let mut clock: Clock = ctx.banks_client.get_sysvar().await.unwrap();
    for s in f["steps"].as_array().unwrap() {
        let label = s["label"].as_str().unwrap();
        clock.unix_timestamp = s["at"].as_i64().unwrap();
        ctx.set_sysvar(&clock);
        let ixs: Vec<Instruction> = s["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|ix| Instruction {
                program_id: Pubkey::from_str(ix["programId"].as_str().unwrap()).unwrap(),
                accounts: ix["keys"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| {
                        let key = Pubkey::from_str(k["pubkey"].as_str().unwrap()).unwrap();
                        if k["isWritable"].as_bool().unwrap() {
                            AccountMeta::new(key, k["isSigner"].as_bool().unwrap())
                        } else {
                            AccountMeta::new_readonly(key, k["isSigner"].as_bool().unwrap())
                        }
                    })
                    .collect(),
                data: hex(ix["data"].as_str().unwrap()),
            })
            .collect();
        let signers: Vec<&Keypair> = s["signers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| match n.as_str().unwrap() {
                "A" => &a,
                "B" => &b,
                "crank" => &crank,
                "authority" => &authority,
                other => panic!("unknown signer {other}"),
            })
            .collect();
        let mut all = vec![&ctx.payer];
        all.extend(signers);
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&ctx.payer.pubkey()), &all, ctx.last_blockhash);
        ctx.banks_client.process_transaction(tx).await.unwrap_or_else(|e| panic!("{label}: {e:?}"));
    }

    // B staked in series 1 and 3. Series 1 went to B (A retired): the pot less the fee. Series 3 refunded B's stake.
    // Series 2 never touched B. Series 4 was frozen: B's stake back in full.
    let fee_cut = 2 * stake * 250 / 10_000;
    assert_eq!(ctx.banks_client.get_balance(b.pubkey()).await.unwrap(), b0 + stake - fee_cut);
    let c = Config::deserialize(&mut &ctx.banks_client.get_account(config).await.unwrap().unwrap().data[..]).unwrap();
    assert_eq!(c.open_stake, 0, "every series closed");
    assert!(!c.paused, "paused, then unpaused");
    // Every setting the update step changed, read back.
    let rotated = Pubkey::new_from_array(ed25519_dalek::PublicKey::from(&ed25519_dalek::SecretKey::from_bytes(&[9; 32]).unwrap()).to_bytes());
    assert_eq!((c.authority, c.ticket_key, c.ticket_key_id), (authority.pubkey(), rotated, 2));
    assert_eq!((c.fee_bps, c.fee_account), (300, crank.pubkey()));
    assert_eq!((c.tiers, c.max_stake, c.open_stake_cap), ([SOL / 100, stake, 0, 0], SOL / 2, 5 * SOL));
}
