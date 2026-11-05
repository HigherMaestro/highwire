"use client";

import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  ADDRESSES,
  coinUrl,
  decodeSignPayload,
  formatLamports,
  lookupTableAddresses,
  platformClaimFeeWallet,
  profileUrl,
  reviewEnvelope,
  type Envelope,
  type EnvelopeReview,
  type ReviewedTransaction,
} from "highwire-core/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirm, getAccountInfo, getBlockHeight, rpcUrlFor, sendRaw, simulate, type SimulationResult } from "../../lib/sign/rpc.ts";
import {
  base58,
  canSign,
  canSignAndSend,
  connect,
  disconnect,
  onAccountsChange,
  sign,
  signAndSend,
  watchWallets,
} from "../../lib/sign/wallets.ts";

// The signing page. Everything happens in this browser: the envelope comes from
// the URL fragment (never sent to any server), the checks run here, simulation
// and sending go straight to a Solana RPC, and the wallet signs. Nothing is
// sent to Highwire.

type Loaded =
  | { state: "loading" }
  | { state: "empty" }
  | { state: "error"; message: string }
  | { state: "ready"; env: Envelope; review: EnvelopeReview; rpcUrl: string; feeWallet: string | null };

type Step = "idle" | "checking" | "signing" | "sending" | "confirming" | "confirmed" | "failed" | "expired";

interface TxState {
  sim?: SimulationResult;
  simulating?: boolean;
  step: Step;
  signature?: string;
  error?: string;
}

const SLOT_SECONDS = 0.4;
const SIM_FRESH_MS = 20_000;

const sol = (lamports: bigint | number) => `${formatLamports(BigInt(lamports))} SOL`;
const signedSol = (lamports: number) => (lamports > 0 ? `+${sol(lamports)}` : lamports < 0 ? `−${sol(-lamports)}` : "0 SOL");
const solscanTx = (sig: string, cluster: Envelope["cluster"]) => `https://solscan.io/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
const solscanAccount = (a: string, cluster: Envelope["cluster"]) => `https://solscan.io/account/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

const KIND_TITLE: Record<Envelope["kind"], string> = {
  trade: "Review a trade",
  launch: "Review a coin launch",
  claim: "Review a creator fee claim",
};

async function load(hash: string): Promise<Loaded> {
  if (!hash.replace(/^#/, "")) return { state: "empty" };
  let env: Envelope;
  try {
    env = await decodeSignPayload(hash);
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const rpcUrl = rpcUrlFor(env.cluster);
  const a = ADDRESSES[env.cluster];
  try {
    // A launch pays its fee to the wallet recorded in higher.fun's New school platform config: read it on-chain.
    let feeWallet: string | null = null;
    if (env.kind === "launch") {
      const info = await getAccountInfo(rpcUrl, a.rewardsPlatform);
      if (info && info.owner === a.launchLabProgram) feeWallet = platformClaimFeeWallet(Uint8Array.from(atob(info.data[0]), (c) => c.charCodeAt(0)));
    }
    const lookupTables: AddressLookupTableAccount[] = [];
    for (const key of lookupTableAddresses(env)) {
      const info = await getAccountInfo(rpcUrl, key);
      if (!info) continue;
      const data = Uint8Array.from(atob(info.data[0]), (c) => c.charCodeAt(0));
      lookupTables.push(new AddressLookupTableAccount({ key: new PublicKey(key), state: AddressLookupTableAccount.deserialize(data) }));
    }
    return { state: "ready", env, review: reviewEnvelope(env, { launchFeeWallet: feeWallet, lookupTables }), rpcUrl, feeWallet };
  } catch (err) {
    return { state: "error", message: `Couldn't read the chain to check this transaction: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function Address({ value, cluster }: { value: string; cluster: Envelope["cluster"] }) {
  return (
    <a className="mono-wrap" href={solscanAccount(value, cluster)} target="_blank" rel="noopener noreferrer">
      {value}
    </a>
  );
}

export function SignApp() {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [height, setHeight] = useState<number | null>(null);
  const [heightError, setHeightError] = useState<string | null>(null);
  const [txs, setTxs] = useState<TxState[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [accounts, setAccounts] = useState<readonly WalletAccount[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const doneRef = useRef<HTMLHeadingElement>(null);

  // Read the fragment, and again if it changes.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      setLoaded({ state: "loading" });
      void load(window.location.hash).then((l) => {
        if (cancelled) return;
        setLoaded(l);
        if (l.state === "ready") setTxs(l.env.transactions.map(() => ({ step: "idle" })));
      });
    };
    run();
    window.addEventListener("hashchange", run);
    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", run);
    };
  }, []);

  useEffect(() => watchWallets(setWallets), []);

  useEffect(() => {
    if (!wallet) return;
    return onAccountsChange(wallet, setAccounts);
  }, [wallet]);

  const ready = loaded.state === "ready" ? loaded : null;
  const env = ready?.env;
  const allDone = txs.length > 0 && txs.every((t) => t.step === "confirmed");

  // Follow the block height for the expiry, until everything has landed.
  useEffect(() => {
    if (!ready || allDone) return;
    let stop = false;
    const tick = async () => {
      try {
        const h = await getBlockHeight(ready.rpcUrl);
        if (!stop) {
          setHeight(h);
          setHeightError(null);
        }
      } catch (err) {
        // Keep the last height; say why there isn't one.
        if (!stop) setHeightError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [ready, allDone]);

  const update = useCallback((i: number, patch: Partial<TxState>) => {
    setTxs((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }, []);

  const runSimulation = useCallback(
    async (i: number): Promise<SimulationResult | null> => {
      if (!ready) return null;
      update(i, { simulating: true });
      try {
        const sim = await simulate(ready.rpcUrl, ready.env.transactions[i]!.base64, ready.env.wallet);
        update(i, { sim, simulating: false });
        return sim;
      } catch (err) {
        const sim: SimulationResult = { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], at: Date.now() };
        update(i, { sim, simulating: false });
        return sim;
      }
    },
    [ready, update],
  );

  // Simulate every transaction that doesn't wait on another, once the review has passed.
  useEffect(() => {
    if (!ready || ready.review.problems.length) return;
    ready.env.transactions.forEach((t, i) => {
      if (t.dependsOn.length === 0) void runSimulation(i);
    });
  }, [ready, runSimulation]);

  const expired = env !== undefined && height !== null && height > env.expiresAfterBlockHeight;
  const secondsLeft = env && height !== null ? Math.max(0, Math.round((env.expiresAfterBlockHeight - height) * SLOT_SECONDS)) : null;
  const account = accounts.find((a) => a.address === env?.wallet) ?? null;
  const wrongAccount = wallet && accounts.length > 0 && !account ? accounts[0]!.address : null;

  async function connectTo(w: Wallet) {
    setWalletError(null);
    setConnecting(w.name);
    try {
      const accs = await connect(w);
      setWallet(w);
      setAccounts(accs);
      setAnnounce(`Connected to ${w.name}.`);
    } catch (err) {
      setWalletError(`${w.name} didn't connect: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  }

  async function disconnectWallet() {
    if (wallet) await disconnect(wallet).catch(() => {});
    setWallet(null);
    setAccounts([]);
    setAnnounce("Wallet disconnected.");
  }

  /** Why transaction i can't be signed right now, or null when it can. */
  function blocker(i: number): string | null {
    if (!ready || !env) return "Loading.";
    const t = env.transactions[i]!;
    const s = txs[i];
    if (ready.review.problems.length) return "This link failed Highwire's checks, so it can't be signed here.";
    if (expired) return "The blockhash has expired. Ask your agent to rebuild it.";
    if (t.dependsOn.some((d) => txs[d]?.step !== "confirmed")) return `Send transaction ${t.dependsOn.map((d) => d + 1).join(", ")} first.`;
    if (!s?.sim) return s?.simulating ? "Simulating…" : "Not simulated yet.";
    if (!s.sim.ok) return s.sim.expired ? "The blockhash has expired. Ask your agent to rebuild it." : "The simulation failed, so this won't be signed.";
    if (!wallet) return "Connect a wallet first.";
    if (!account) return `The connected wallet isn't the fee payer. Switch to ${env.wallet} in your wallet.`;
    return null;
  }

  async function signAndSendTx(i: number) {
    if (!ready || !wallet || !account || !env) return;
    const t = env.transactions[i]!;
    const reviewed = ready.review.transactions[i]!;
    const original = reviewed.tx!;
    update(i, { step: "checking", error: undefined });
    try {
      // Fresh checks right before the wallet sees it.
      const h = await getBlockHeight(ready.rpcUrl);
      setHeight(h);
      if (h > t.lastValidBlockHeight) {
        update(i, { step: "expired", error: "The blockhash has expired. Ask your agent to rebuild it." });
        return;
      }
      const prior = txs[i]?.sim;
      const sim = prior?.ok && Date.now() - prior.at < SIM_FRESH_MS ? prior : await runSimulation(i);
      if (!sim?.ok) {
        update(i, { step: "idle", error: sim?.expired ? "The blockhash has expired. Ask your agent to rebuild it." : "The simulation failed, so this won't be signed." });
        return;
      }

      const bytes = original.serialize();
      let signature: string;
      update(i, { step: "signing" });
      setAnnounce(`Approve transaction ${i + 1} in ${wallet.name}.`);
      // A transaction with a presigned mint goes through signTransaction, which keeps that signature, and we send it.
      const useSignOnly = canSign(wallet) && (t.presigned.length > 0 || !canSignAndSend(wallet));
      if (useSignOnly) {
        const signedBytes = await sign(wallet, account, env.cluster, bytes);
        const signed = VersionedTransaction.deserialize(signedBytes);
        const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);
        if (!same(signed.message.serialize(), original.message.serialize())) {
          update(i, { step: "failed", error: "Your wallet changed the transaction before signing it, so it wasn't sent." });
          return;
        }
        const keys = original.message.staticAccountKeys.map((k) => k.toBase58());
        for (const p of t.presigned) {
          const k = keys.indexOf(p);
          if (k < 0 || !same(signed.signatures[k]!, original.signatures[k]!)) {
            update(i, { step: "failed", error: "Your wallet dropped the coin's mint signature, so the transaction wasn't sent." });
            return;
          }
        }
        update(i, { step: "sending" });
        signature = await sendRaw(ready.rpcUrl, signed.serialize());
      } else {
        signature = base58(await signAndSend(wallet, account, env.cluster, bytes));
      }

      update(i, { step: "confirming", signature });
      setAnnounce(`Transaction ${i + 1} sent. Waiting for confirmation.`);
      const result = await confirm(ready.rpcUrl, signature, t.lastValidBlockHeight);
      if (result.status === "confirmed") {
        update(i, { step: "confirmed" });
        setAnnounce(`Transaction ${i + 1} confirmed.`);
        // Anything that waited on this one can be simulated now.
        env.transactions.forEach((next, j) => {
          if (next.dependsOn.includes(i)) void runSimulation(j);
        });
      } else if (result.status === "expired") {
        update(i, { step: "expired", error: "It didn't land before the blockhash expired. Ask your agent to rebuild it." });
      } else {
        update(i, { step: "failed", error: `It failed on-chain: ${result.error}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      update(i, { step: "idle", error: /reject|denied|cancel/i.test(message) ? "You declined in your wallet. Nothing was sent." : message });
    }
  }

  useEffect(() => {
    if (allDone) doneRef.current?.focus();
  }, [allDone]);

  const coinLinks = useMemo(() => {
    if (!ready) return [];
    return [...ready.review.launches, ...ready.review.coins];
  }, [ready]);

  if (loaded.state === "loading") {
    return (
      <section className="sign-panel" aria-busy="true">
        <h1>Checking the transaction…</h1>
        <p className="muted">Decoding the link and reading the chain. Nothing leaves this browser except calls to a Solana RPC.</p>
      </section>
    );
  }
  if (loaded.state === "empty") {
    return (
      <section className="sign-panel">
        <h1>Sign a transaction</h1>
        <p>
          This page signs transactions that Highwire built for you. Ask your agent to build a trade, a launch or a fee claim, and
          open the <code>sign_url</code> it gives you. The transaction travels in the part of the link after <code>#</code>,
          which your browser never sends to any server.
        </p>
      </section>
    );
  }
  if (loaded.state === "error") {
    return (
      <section className="sign-panel" role="alert">
        <h1>This link can&apos;t be signed</h1>
        <p>{loaded.message}</p>
        <p className="muted">Ask your agent to build the transaction again and send you a fresh link.</p>
      </section>
    );
  }

  const { review } = loaded;
  const cluster = loaded.env.cluster;
  const e = loaded.env;
  const refused = review.problems.length > 0;

  return (
    <>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      <section className="sign-panel" aria-labelledby="sign-title">
        <p className="eyebrow">Highwire sign page{cluster === "devnet" ? " · devnet" : ""}</p>
        <h1 id="sign-title">{KIND_TITLE[e.kind]}</h1>
        {cluster === "devnet" ? (
          <p className="sign-flag">Devnet: test SOL only. Make sure your wallet is set to devnet.</p>
        ) : null}
        <dl className="sign-facts">
          <div>
            <dt>Fee payer and signer</dt>
            <dd>
              <Address value={e.wallet} cluster={cluster} />
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>Solana {cluster}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              {expired ? (
                <strong className="sign-bad">Expired. Ask your agent to rebuild it.</strong>
              ) : secondsLeft === null ? (
                <>
                  after block {e.expiresAfterBlockHeight.toLocaleString("en-US")}
                  {heightError ? <span className="sign-bad small"> (can&apos;t read the current block: {heightError})</span> : null}
                </>
              ) : (
                `in about ${secondsLeft} seconds (block ${e.expiresAfterBlockHeight.toLocaleString("en-US")})`
              )}
            </dd>
          </div>
          <div>
            <dt>Transactions</dt>
            <dd>{e.transactions.length === 1 ? "1" : `${e.transactions.length}, signed and sent in order`}</dd>
          </div>
        </dl>
      </section>

      {refused ? (
        <section className="sign-panel sign-refuse" role="alert" aria-labelledby="refuse-title">
          <h2 id="refuse-title">Don&apos;t sign this</h2>
          <p>It failed the checks Highwire runs on every transaction it builds. This page won&apos;t ask your wallet to sign it.</p>
          <ul>
            {review.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <WalletPanel
        wallets={wallets}
        wallet={wallet}
        account={account}
        wrongAccount={wrongAccount}
        feePayer={e.wallet}
        connecting={connecting}
        error={walletError}
        onConnect={connectTo}
        onDisconnect={disconnectWallet}
      />

      <ol className="sign-txs" aria-label="Transactions">
        {review.transactions.map((rt, i) => (
          <TxCard
            key={i}
            rt={rt}
            total={review.transactions.length}
            env={e}
            state={txs[i] ?? { step: "idle" }}
            blocker={blocker(i)}
            onSimulate={() => void runSimulation(i)}
            onSign={() => void signAndSendTx(i)}
          />
        ))}
      </ol>

      {allDone ? (
        <section className="sign-panel sign-done" aria-labelledby="done-title">
          <h2 id="done-title" tabIndex={-1} ref={doneRef}>
            Done
          </h2>
          <p>Everything confirmed on Solana {cluster}.</p>
          <ul className="plain">
            {txs.map((t, i) =>
              t.signature ? (
                <li key={i}>
                  Transaction {i + 1}:{" "}
                  <a href={solscanTx(t.signature, cluster)} target="_blank" rel="noopener noreferrer">
                    view on Solscan
                  </a>
                </li>
              ) : null,
            )}
            {cluster === "mainnet"
              ? coinLinks.map((m) => (
                  <li key={m}>
                    <a href={coinUrl(m)} target="_blank" rel="noopener noreferrer">
                      The coin on higher.fun
                    </a>{" "}
                    <span className="muted mono-wrap">({m})</span>
                  </li>
                ))
              : null}
            {cluster === "mainnet" && e.kind === "claim" ? (
              <li>
                <a href={profileUrl(e.wallet)} target="_blank" rel="noopener noreferrer">
                  Your profile on higher.fun
                </a>
              </li>
            ) : null}
          </ul>
          {cluster === "devnet" ? <p className="muted small">higher.fun lists mainnet coins only.</p> : null}
        </section>
      ) : null}

      <aside className="sign-panel sign-privacy" aria-label="What this page does">
        <h2>What this page does</h2>
        <ul>
          <li>
            Reads the transaction from the link&apos;s fragment, which browsers never send to a server, and checks every
            instruction against the list of what Highwire builds.
          </li>
          <li>
            Simulates and sends only through the Solana RPC at <code>{new URL(loaded.rpcUrl).host}</code>, straight from your
            browser. Nothing is sent to Highwire.
          </li>
          <li>Never asks for a private key or seed phrase. Only your wallet signs.</li>
        </ul>
        <p className="small muted">
          <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · Not financial advice.
        </p>
      </aside>
    </>
  );
}

function WalletPanel(props: {
  wallets: Wallet[];
  wallet: Wallet | null;
  account: WalletAccount | null;
  wrongAccount: string | null;
  feePayer: string;
  connecting: string | null;
  error: string | null;
  onConnect: (w: Wallet) => void;
  onDisconnect: () => void;
}) {
  const { wallets, wallet, account, wrongAccount, feePayer, connecting, error } = props;
  return (
    <section className="sign-panel" aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet</h2>
      {wallet ? (
        <div className="sign-wallet-row">
          <p>
            Connected: <strong>{wallet.name}</strong>
            {account ? (
              <>
                {" "}
                as <span className="mono-wrap">{account.address}</span>, the fee payer.
              </>
            ) : null}
          </p>
          <button type="button" className="button button-quiet" onClick={props.onDisconnect}>
            Disconnect
          </button>
        </div>
      ) : wallets.length ? (
        <>
          <p className="muted small">Wallets found in this browser:</p>
          <ul className="sign-wallets">
            {wallets.map((w) => (
              <li key={w.name}>
                <button type="button" className="sign-wallet" onClick={() => props.onConnect(w)} disabled={connecting !== null}>
                  {/* Wallet Standard icons are data: URIs. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={w.icon} alt="" width={28} height={28} />
                  <span>{connecting === w.name ? `Connecting to ${w.name}…` : `Connect ${w.name}`}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          No Solana wallet found in this browser. Install or unlock Phantom, Solflare or Backpack, then reload. On a phone, open
          this link in your wallet app&apos;s browser.
        </p>
      )}
      {wrongAccount ? (
        <p className="sign-bad" role="alert">
          The connected account {wrongAccount} isn&apos;t the fee payer. Switch to {feePayer} in your wallet. This page won&apos;t
          sign with any other account.
        </p>
      ) : null}
      {error ? (
        <p className="sign-bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const STEP_TEXT: Partial<Record<Step, string>> = {
  checking: "Checking again…",
  signing: "Waiting for your wallet…",
  sending: "Sending…",
  confirming: "Confirming…",
};

function TxCard(props: {
  rt: ReviewedTransaction;
  total: number;
  env: Envelope;
  state: TxState;
  blocker: string | null;
  onSimulate: () => void;
  onSign: () => void;
}) {
  const { rt, total, env, state, blocker } = props;
  const n = rt.index + 1;
  const spends = rt.effects.filter((x) => x.kind === "spend");
  const receives = rt.effects.filter((x) => x.kind === "receive");
  const other = rt.effects.filter((x) => x.kind === "other");
  const busy = state.step === "checking" || state.step === "signing" || state.step === "sending" || state.step === "confirming";
  const blockerId = `tx-${n}-blocker`;
  const sim = state.sim;
  const waiting = rt.dependsOn.length > 0 && !sim;

  return (
    <li className="sign-panel sign-tx" aria-labelledby={`tx-${n}-title`}>
      <h2 id={`tx-${n}-title`}>
        {total > 1 ? `Transaction ${n} of ${total}: ` : ""}
        {rt.label}
      </h2>

      {spends.length || receives.length || other.length ? (
        <div className="sign-effects">
          {spends.length ? (
            <div>
              <h3>You spend</h3>
              <ul>
                {spends.map((x) => (
                  <li key={x.text} className="mono-wrap">
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {receives.length ? (
            <div>
              <h3>You receive</h3>
              <ul>
                {receives.map((x) => (
                  <li key={x.text} className="mono-wrap">
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {other.length ? (
            <div>
              <h3>Also</h3>
              <ul>
                {other.map((x) => (
                  <li key={x.text} className="mono-wrap">
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <h3>Fees</h3>
      <ul className="sign-fees">
        <li>Network fee: {sol(rt.networkFeeLamports)}</li>
        <li>Priority fee: {rt.priorityFeeLamports > 0n ? `up to ${sol(rt.priorityFeeLamports)}` : "none"}</li>
        {sim?.ok && sim.netLamports !== undefined ? (
          <li>
            Simulated change to your SOL balance, fees and account deposits included: <strong>{signedSol(sim.netLamports)}</strong>
          </li>
        ) : null}
      </ul>

      <details className="sign-details" open={total === 1}>
        <summary>Every instruction, decoded from the transaction itself</summary>
        {/* The lines carry their own numbers, so the list doesn't add any. */}
        <ul className="sign-lines">
          {rt.summary.map((line) => (
            <li key={line} className="mono-wrap">
              {line}
            </li>
          ))}
        </ul>
        {!rt.summaryMatches && rt.summary.length ? (
          <p className="sign-bad small">The link&apos;s own description doesn&apos;t match these bytes. Trust the lines above, not the link.</p>
        ) : null}
      </details>

      <div className="sign-sim" aria-live="polite">
        <h3>Simulation</h3>
        {waiting ? (
          <p className="muted">Runs once transaction {rt.dependsOn.map((d) => d + 1).join(", ")} has confirmed.</p>
        ) : state.simulating ? (
          <p className="muted">Simulating on Solana {env.cluster}…</p>
        ) : sim ? (
          sim.ok ? (
            <p className="sign-good">Passed{sim.unitsConsumed ? `, ${sim.unitsConsumed.toLocaleString("en-US")} compute units` : ""}.</p>
          ) : (
            <div className="sign-bad">
              <p>
                Failed: {sim.error}
                {sim.expired ? " Ask your agent to rebuild it." : ""}
              </p>
              {sim.logs.length ? (
                <details>
                  <summary>Program logs</summary>
                  <pre className="sign-logs">{sim.logs.join("\n")}</pre>
                </details>
              ) : null}
            </div>
          )
        ) : (
          <p className="muted">Not run{rt.problems.length ? ": the checks failed" : ""}.</p>
        )}
        {!waiting && !rt.problems.length && state.step === "idle" ? (
          <button type="button" className="button button-quiet button-small" onClick={props.onSimulate} disabled={state.simulating}>
            Simulate again
          </button>
        ) : null}
      </div>

      <div className="sign-action">
        {state.step === "confirmed" && state.signature ? (
          <p className="sign-good">
            Confirmed.{" "}
            <a href={solscanTx(state.signature, env.cluster)} target="_blank" rel="noopener noreferrer">
              View on Solscan
            </a>
            <span className="mono-wrap small muted"> {state.signature}</span>
          </p>
        ) : (
          <>
            <button
              type="button"
              className="button"
              onClick={props.onSign}
              disabled={blocker !== null || busy}
              aria-describedby={blocker ? blockerId : undefined}
            >
              {busy ? STEP_TEXT[state.step] : total > 1 ? `Sign and send transaction ${n}` : "Sign and send"}
            </button>
            {blocker && !busy ? (
              <p id={blockerId} className="muted small">
                {blocker}
              </p>
            ) : null}
            {state.signature && state.step !== "confirmed" ? (
              <p className="small">
                Signature:{" "}
                <a className="mono-wrap" href={solscanTx(state.signature, env.cluster)} target="_blank" rel="noopener noreferrer">
                  {state.signature}
                </a>
              </p>
            ) : null}
            {state.error ? (
              <p className="sign-bad" role="alert">
                {state.error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}
