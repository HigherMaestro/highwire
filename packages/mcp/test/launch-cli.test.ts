import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeypairFile, LAUNCH_POLICY_TEMPLATE, loadKeypair } from "highwire-agent";
import { defaultLaunchKey, parseLaunchArgs, runLaunch, runPolicyInit, runPost, runWallet } from "../src/launch-cli.ts";

// Unit tests only: wallets are throwaway files in a temp folder, never funded, and nothing here reaches a cluster.

const home = () => mkdtempSync(join(tmpdir(), "highwire-cli-"));
const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

test("launch flags become execute_launch's arguments", () => {
  const p = parseLaunchArgs(["--name", "Cat Demo", "--ticker", "$catdemo", "--image", "cat.png", "--buy", "0.05", "--description", "meow", "--x", "https://x.com/cat"]);
  assert.ok(!("error" in p));
  assert.deepEqual(p.args, {
    name: "Cat Demo",
    ticker: "catdemo",
    fee_mode: "rewards",
    image_path: resolve("cat.png"),
    description: "meow",
    dev_buy_sol: 0.05,
    x: "https://x.com/cat",
    confirm_launch: true,
  });
  assert.equal(p.json, false);
  assert.equal((parseLaunchArgs(["--ticker", "A", "--image", "a.png"]) as { error: string }).error, "give --name");
  assert.match((parseLaunchArgs(["--name", "A", "--ticker", "A"]) as { error: string }).error, /--image/);
  assert.match((parseLaunchArgs(["--name", "A", "--ticker", "A", "--image", "a.png", "--mode", "pump"]) as { error: string }).error, /rewards or classic/);
  assert.match((parseLaunchArgs(["--name", "A", "--ticker", "A", "--image", "a.png", "--buy", "lots"]) as { error: string }).error, /--buy/);
  assert.match((parseLaunchArgs(["--name", "A", "--ticker", "A", "--metadata-uri", "ftp://x"]) as { error: string }).error, /http/);
  assert.ok("error" in parseLaunchArgs(["--name", "A", "--ticker", "A", "--image", "a.png", "--yolo"]));
});

test("the default launch key is the same for the same coin, so a retry can't launch it twice", () => {
  const w = "7bK1LThaA8xMKpmJt3wosCRcYvVA2R8V2PzoiAdqfu4B";
  assert.equal(defaultLaunchKey(w, "Cat Demo", "catdemo", "rewards"), defaultLaunchKey(w, "Cat Demo", "CATDEMO", "rewards"));
  assert.notEqual(defaultLaunchKey(w, "Cat Demo", "CATDEMO", "rewards"), defaultLaunchKey(w, "Cat Demo", "CATDEMO", "classic"));
  assert.match(defaultLaunchKey(w, "x", "X", "rewards"), /^cli-[0-9a-f]{32}$/);
});

test("wallet new makes a private keypair file, prints only the address, and never overwrites", async () => {
  const h = home();
  const c = capture();
  assert.equal(await runWallet(["new"], { ...c.io, env: { HIGHWIRE_HOME: h } }), 0);
  const file = join(h, "wallet.json");
  const address = loadKeypair(file).keypair.publicKey.toBase58();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(c.out.join("\n").includes(address));
  const secret = readFileSync(file, "utf8");
  assert.ok(!c.out.join("\n").includes(secret.slice(1, 30)), "the key is never printed");
  // again: the same wallet, untouched
  const again = createKeypairFile(file);
  assert.deepEqual(again, { address, written: false });
  assert.equal(readFileSync(file, "utf8"), secret);
  const a = capture();
  assert.equal(await runWallet(["address"], { ...a.io, env: { HIGHWIRE_HOME: h } }), 0);
  assert.deepEqual(a.out, [address]);
  // a file that isn't a keypair is never replaced
  const junk = join(h, "junk.json");
  writeFileSync(junk, "not a key");
  assert.throws(() => createKeypairFile(junk), (e: Error) => (e as { code?: string }).code === "bad_keypair");
  assert.equal(readFileSync(junk, "utf8"), "not a key");
});

test("policy init --launch writes a mainnet launch policy, dry run unless --live, and never replaces one", () => {
  const h = home();
  const c = capture();
  assert.equal(runPolicyInit(["--launch"], { ...c.io, env: { HIGHWIRE_HOME: h } }), 0);
  const policy = JSON.parse(readFileSync(join(h, "policy.json"), "utf8"));
  assert.deepEqual(policy, { ...LAUNCH_POLICY_TEMPLATE, live: false });
  assert.match(c.out[0]!, /dry run/);
  // a second init, even asking for live, leaves it alone
  const again = capture();
  assert.equal(runPolicyInit(["--launch", "--live"], { ...again.io, env: { HIGHWIRE_HOME: h } }), 0);
  assert.match(again.out[0]!, /already exists/);
  assert.equal(JSON.parse(readFileSync(join(h, "policy.json"), "utf8")).live, false);

  const h2 = home();
  runPolicyInit(["--launch", "--live"], { ...capture().io, env: { HIGHWIRE_HOME: h2 } });
  assert.equal(JSON.parse(readFileSync(join(h2, "policy.json"), "utf8")).live, true);
  // --live alone would make the devnet starter live by surprise: refused
  assert.equal(runPolicyInit(["--live"], { ...capture().io, env: { HIGHWIRE_HOME: home() } }), 2);
  // --devnet: the same launch policy, for trying it on devnet first
  const h3 = home();
  runPolicyInit(["--launch", "--devnet"], { ...capture().io, env: { HIGHWIRE_HOME: h3 } });
  assert.deepEqual(JSON.parse(readFileSync(join(h3, "policy.json"), "utf8")), { ...LAUNCH_POLICY_TEMPLATE, live: false, cluster: "devnet" });
});

test("launch without a wallet says how to make one, and touches nothing", async () => {
  const c = capture();
  assert.equal(await runLaunch(["--name", "Cat", "--ticker", "CAT", "--image", "cat.png"], { ...c.io, env: { HIGHWIRE_HOME: home() } }), 1);
  assert.match(c.err.join("\n"), /highwire wallet new/);
  const u = capture();
  assert.equal(await runLaunch(["--ticker", "CAT"], { ...u.io, env: { HIGHWIRE_HOME: home() } }), 2);
  assert.match(u.err[0]!, /give --name/);
});

test("orders claim needs --every-hours and a wallet, and touches nothing without them", async () => {
  const { runOrders } = await import("../src/orders-cli.ts");
  const signal = new AbortController().signal;
  const u = capture();
  assert.equal(await runOrders(["claim"], { ...u.io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
  assert.match(u.err[0]!, /--every-hours/);
  const n = capture();
  assert.equal(await runOrders(["claim", "--every-hours", "lots"], { ...n.io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
  const w = capture();
  assert.equal(await runOrders(["claim", "--every-hours", "24"], { ...w.io, signal, env: { HIGHWIRE_HOME: home() } }), 1);
  assert.match(w.err.join("\n"), /highwire wallet new/);
});

test("post needs exactly one of --mint and --chat, and text, and a wallet", async () => {
  for (const argv of [["hello"], ["--chat"], ["--chat", "--mint", "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix", "hi"], ["--yolo", "hi"]]) {
    assert.equal(await runPost(argv, { ...capture().io, env: { HIGHWIRE_HOME: home() } }), 2, argv.join(" "));
  }
  const w = capture();
  assert.equal(await runPost(["--chat", "gm"], { ...w.io, env: { HIGHWIRE_HOME: home() } }), 1);
  assert.match(w.err.join("\n"), /highwire wallet new/);
});

test("orders limit-buy needs a mint, sol and exactly one trigger, and a wallet", async () => {
  const { runOrders } = await import("../src/orders-cli.ts");
  const signal = new AbortController().signal;
  const M = "EE3p42u2rACc3PEDcgVdqfg8JRxSYdvbn53rFoc3i1ix";
  for (const argv of [["limit-buy"], ["limit-buy", "--mint", M, "--sol", "0.1"], ["limit-buy", "--mint", M, "--sol", "0.1", "--price", "1", "--drop-pct", "20"], ["limit-buy", "--mint", M, "--sol", "x", "--drop-pct", "20"]]) {
    assert.equal(await runOrders(argv, { ...capture().io, signal, env: { HIGHWIRE_HOME: home() } }), 2, argv.join(" "));
  }
  const w = capture();
  assert.equal(await runOrders(["limit-buy", "--mint", M, "--sol", "0.1", "--drop-pct", "20"], { ...w.io, signal, env: { HIGHWIRE_HOME: home() } }), 1);
  assert.match(w.err.join("\n"), /highwire wallet new/);
});

test("line: usage, and run or series need the signer's keypair; nothing starts without it", async () => {
  const { runLine, LINE_USAGE } = await import("../src/line-cli.ts");
  const signal = new AbortController().signal;
  const u = capture();
  assert.equal(await runLine([], { ...u.io, signal, env: { HIGHWIRE_HOME: home() } }), 0);
  assert.equal(u.out[0], LINE_USAGE);
  assert.equal(await runLine(["dance"], { ...capture().io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
  for (const cmd of ["run", "series"]) {
    const w = capture();
    assert.equal(await runLine([cmd], { ...w.io, signal, env: { HIGHWIRE_HOME: home() } }), 2);
    assert.match(w.err.join("\n"), /HIGHWIRE_KEYPAIR_PATH/);
  }
});
