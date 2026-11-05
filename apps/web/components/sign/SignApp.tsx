"use client";

import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  ADDRESSES,
  assertSameExceptBlockhash,
  canRefresh,
  coinUrl,
  decodeSignPayload,
  formatLamports,
  linkAgeSeconds,
  lookupTableAddresses,
  platformClaimFeeWallet,
  profileUrl,
  REFRESH_MAX_AGE_SECONDS,
  refreshableIndexes,
  refreshEnvelope,
  reviewEnvelope,
  STALE_WARNING_SECONDS,
  type Envelope,
  type EnvelopeReview,
  type ReviewContext,
  type ReviewedTransaction,
} from "highwire-core/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  confirm,
  getAccountInfo,
  getBlockHeight,
  getLatestBlockhash,
  rpcUrlFor,
  sendRaw,
  simulate,
  type SimulationResult,
} from "../../lib/sign/rpc.ts";
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
//
// Blockhashes last about a minute. A transaction that only the user's wallet
// signs (a trade, a claim) takes a fresh blockhash on load and again right
// before the wallet sees it, for up to 10 minutes after the link was built;
// nothing else in it may change (highwire-core's refresh.ts checks). One that
// carries another signature (a launch's mint) keeps its original expiry.

type Ready = {
  state: "ready";
  /** The envelope exactly as the link carried it. Every refresh starts from these bytes. */
  link: Envelope;
  /** What the page shows and signs: the link with fresh blockhashes on its refreshable transactions. */
  env: Envelope;
  review: EnvelopeReview;
  ctx: ReviewContext;
  rpcUrl: string;
  /** Transactions that may take a fresh blockhash (only the wallet signs, and the link says when it was built). */
  refreshable: number[];
};

type Loaded = { state: "loading" } | { state: "empty" } | { state: "error"; message: string } | Ready;

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
/** Refresh a refreshable transaction's blockhash this many blocks (about 12 seconds) before it would expire. */
const REFRESH_MARGIN_BLOCKS = 30;
const REBUILD = "Ask your agent to rebuild it.";
const TOO_OLD = `This quote is more than ${REFRESH_MAX_AGE_SECONDS / 60} minutes old. ${REBUILD}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const sol = (lamports: bigint | number) => `${formatLamports(BigInt(lamports))} SOL`;
const signedSol = (lamports: number) => (lamports > 0 ? `+${sol(lamports)}` : lamports < 0 ? `−${sol(-lamports)}` : "0 SOL");
const solscanTx = (sig: string, cluster: Envelope["cluster"]) => `https://solscan.io/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
const solscanAccount = (a: string, cluster: Envelope["cluster"]) => `https://solscan.io/account/${a}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
const clock = (unixSeconds: number) => new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const KIND_TITLE: Record<Envelope["kind"], string> = {
  trade: "Review a trade",
  launch: "Review a coin launch",
  claim: "Review a creator fee claim",
};

/** `env` with the given transactions taken from `fresh`. */
function merge(env: Envelope, fresh: Envelope, indexes: number[]): Envelope {
  return { ...env, transactions: env.transactions.map((t, i) => (indexes.includes(i) ? fresh.transactions[i]! : t)) };
}

async function load(hash: string): Promise<Loaded> {
  if (!hash.replace(/^#/, "")) return { state: "empty" };
  let link: Envelope;
  try {
    link = await decodeSignPayload(hash);
  } catch (err) {
    return { state: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const rpcUrl = rpcUrlFor(link.cluster);
  const a = ADDRESSES[link.cluster];
  try {
    // A launch pays its fee to the wallet recorded in higher.fun's New school platform config: read it on-chain.
    let feeWallet: string | null = null;
    if (link.kind === "launch") {
      const info = await getAccountInfo(rpcUrl, a.rewardsPlatform);
      if (info && info.owner === a.launchLabProgram) feeWallet = platformClaimFeeWallet(Uint8Array.from(atob(info.data[0]), (c) => c.charCodeAt(0)));
    }
    const lookupTables: AddressLookupTableAccount[] = [];
    for (const key of lookupTableAddresses(link)) {
      const info = await getAccountInfo(rpcUrl, key);
      if (!info) continue;
      const data = Uint8Array.from(atob(info.data[0]), (c) => c.charCodeAt(0));
      lookupTables.push(new AddressLookupTableAccount({ key: new PublicKey(key), state: AddressLookupTableAccount.deserialize(data) }));
    }
    const ctx: ReviewContext = { launchFeeWallet: feeWallet, lookupTables };
    const refreshable = link.builtAt === undefined ? [] : refreshableIndexes(link);
    let env = link;
    if (refreshable.length && canRefresh(link, nowSeconds())) {
      env = refreshEnvelope(link, await getLatestBlockhash(rpcUrl), nowSeconds()).env;
    }
    return { state: "ready", link, env, review: reviewEnvelope(env, ctx), ctx, rpcUrl, refreshable };
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
  const [now, setNow] = useState(nowSeconds);
  const [txs, setTxs] = useState<TxState[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [accounts, setAccounts] = useState<readonly WalletAccount[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const doneRef = useRef<HTMLHeadingElement>(null);
  // The latest ready state, for async work that outlives a render.
  const readyRef = useRef<Ready | null>(null);
  const refreshing = useRef(new Set<number>());

  // Read the fragment, and again if it changes.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      setLoaded({ state: "loading" });
      void load(window.location.hash).then((l) => {
        if (cancelled) return;
        readyRef.current = l.state === "ready" ? l : null;
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

  // Follow the block height and the clock for the expiry and the link's age, until everything has landed.
  useEffect(() => {
    if (!ready?.rpcUrl || allDone) return;
    const rpcUrl = ready.rpcUrl;
    let stop = false;
    const tick = async () => {
      setNow(nowSeconds());
      try {
        const h = await getBlockHeight(rpcUrl);
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
  }, [ready?.rpcUrl, allDone]);

  const update = useCallback((i: number, patch: Partial<TxState>) => {
    setTxs((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }, []);

  /**
   * Gives transactions `indexes` a fresh blockhash, starting from the link's own bytes, and reviews the result again.
   * Returns null when the link is too old to refresh.
   */
  const refreshNow = useCallback(async (indexes: number[]): Promise<{ env: Envelope; review: EnvelopeReview } | null> => {
    const r = readyRef.current;
    if (!r || !canRefresh(r.link, nowSeconds())) return null;
    const want = indexes.filter((i) => r.refreshable.includes(i));
    if (!want.length) return { env: r.env, review: r.review };
    const fresh = refreshEnvelope(r.link, await getLatestBlockhash(r.rpcUrl), nowSeconds(), want).env;
    const current = readyRef.current ?? r;
    const env = merge(current.env, fresh, want);
    const next: Ready = { ...current, env, review: reviewEnvelope(env, current.ctx) };
    readyRef.current = next;
    setLoaded(next);
    return { env: next.env, review: next.review };
  }, []);

  const runSimulation = useCallback(
    async (i: number, on?: Envelope): Promise<SimulationResult | null> => {
      const r = readyRef.current;
      const target = on ?? r?.env;
      if (!r || !target) return null;
      update(i, { simulating: true });
      try {
        const sim = await simulate(r.rpcUrl, target.transactions[i]!.base64, target.wallet);
        update(i, { sim, simulating: false });
        return sim;
      } catch (err) {
        const sim: SimulationResult = { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], at: Date.now() };
        update(i, { sim, simulating: false });
        return sim;
      }
    },
    [update],
  );

  /** Refreshes the blockhash if the transaction may take one, then simulates. */
  const prepare = useCallback(
    async (i: number) => {
      const r = readyRef.current;
      if (!r || refreshing.current.has(i)) return;
      refreshing.current.add(i);
      try {
        const fresh = r.refreshable.includes(i) ? await refreshNow([i]) : null;
        if (fresh && fresh.review.transactions[i]!.problems.length) return;
        await runSimulation(i, fresh?.env);
      } catch (err) {
        update(i, { sim: { ok: false, error: err instanceof Error ? err.message : String(err), logs: [], at: Date.now() } });
      } finally {
        refreshing.current.delete(i);
      }
    },
    [refreshNow, runSimulation, update],
  );

  // Simulate every transaction that doesn't wait on another, once the review has passed.
  const loadedLink = ready?.link;
  useEffect(() => {
    const r = readyRef.current;
    if (!r || r.review.problems.length) return;
    r.env.transactions.forEach((t, i) => {
      if (t.dependsOn.length === 0) void runSimulation(i);
    });
  }, [loadedLink, runSimulation]);

  // Keep refreshable transactions' blockhashes fresh while the link is young enough.
  useEffect(() => {
    const r = readyRef.current;
    if (!r || height === null || r.review.problems.length || !canRefresh(r.link, nowSeconds())) return;
    for (const i of r.refreshable) {
      const t = r.env.transactions[i]!;
      const s = txs[i];
      if (s?.step !== "idle" || s.simulating || t.dependsOn.some((d) => txs[d]?.step !== "confirmed")) continue;
      if (height > t.lastValidBlockHeight - REFRESH_MARGIN_BLOCKS || s.sim?.expired) void prepare(i);
    }
  }, [height, txs, prepare]);

  const age = ready ? linkAgeSeconds(ready.link, now) : null;
  const tooOld = age !== null && age > REFRESH_MAX_AGE_SECONDS;
  const isRefreshing = (i: number) => !!ready && ready.refreshable.includes(i) && !tooOld;
  const strictOpen = env ? env.transactions.map((_, i) => i).filter((i) => !isRefreshing(i) && txs[i]?.step !== "confirmed") : [];
  const strictExpiry = strictOpen.length && env ? Math.min(...strictOpen.map((i) => env.transactions[i]!.lastValidBlockHeight)) : null;
  const strictExpired = strictExpiry !== null && height !== null && height > strictExpiry;
  const secondsLeft = strictExpiry !== null && height !== null ? Math.max(0, Math.round((strictExpiry - height) * SLOT_SECONDS)) : null;
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
    const fresh = ready.refreshable.includes(i);
    if (ready.review.problems.length) return "This link failed Highwire's checks, so it can't be signed here.";
    if (fresh && tooOld) return TOO_OLD;
    if (!fresh && height !== null && height > t.lastValidBlockHeight) return `The blockhash has expired. ${REBUILD}`;
    if (t.dependsOn.some((d) => txs[d]?.step !== "confirmed")) return `Send transaction ${t.dependsOn.map((d) => d + 1).join(", ")} first.`;
    if (!s?.sim) return s?.simulating ? "Simulating…" : "Not simulated yet.";
    // An expired blockhash on a refreshable transaction is replaced before signing, so only a real failure blocks.
    if (!s.sim.ok && !(fresh && s.sim.expired)) {
      return s.sim.expired ? `The blockhash has expired. ${REBUILD}` : "The simulation failed, so this won't be signed.";
    }
    if (!wallet) return "Connect a wallet first.";
    if (!account) return `The connected wallet isn't the fee payer. Switch to ${env.wallet} in your wallet.`;
    return null;
  }

  async function signAndSendTx(i: number) {
    const r0 = readyRef.current;
    if (!r0 || !wallet || !account) return;
    update(i, { step: "checking", error: undefined });
    try {
      let current = { env: r0.env, review: r0.review };
      let sim: SimulationResult | null;
      if (r0.refreshable.includes(i)) {
        // A fresh blockhash right before the wallet sees it, from the link's own bytes, checked and simulated again.
        if (!canRefresh(r0.link, nowSeconds())) {
          update(i, { step: "expired", error: TOO_OLD });
          return;
        }
        const fresh = await refreshNow([i]);
        if (!fresh) {
          update(i, { step: "expired", error: TOO_OLD });
          return;
        }
        current = fresh;
        const linkTx = VersionedTransaction.deserialize(Uint8Array.from(atob(r0.link.transactions[i]!.base64), (c) => c.charCodeAt(0)));
        assertSameExceptBlockhash(linkTx, current.review.transactions[i]!.tx!);
        if (current.review.transactions[i]!.problems.length) {
          update(i, { step: "idle", error: "The refreshed transaction failed Highwire's checks, so it won't be signed." });
          return;
        }
        sim = await runSimulation(i, current.env);
      } else {
        const t0 = r0.env.transactions[i]!;
        const h = await getBlockHeight(r0.rpcUrl);
        setHeight(h);
        if (h > t0.lastValidBlockHeight) {
          update(i, { step: "expired", error: `The blockhash has expired. ${REBUILD}` });
          return;
        }
        const prior = txs[i]?.sim;
        sim = prior?.ok && Date.now() - prior.at < SIM_FRESH_MS ? prior : await runSimulation(i);
      }
      if (!sim?.ok) {
        update(i, { step: "idle", error: sim?.expired ? `The blockhash has expired. ${REBUILD}` : "The simulation failed, so this won't be signed." });
        return;
      }

      const t = current.env.transactions[i]!;
      const original = current.review.transactions[i]!.tx!;
      const bytes = original.serialize();
      let signature: string;
      update(i, { step: "signing" });
      setAnnounce(`Approve transaction ${i + 1} in ${wallet.name}.`);
      // A transaction with a presigned mint goes through signTransaction, which keeps that signature, and we send it.
      const useSignOnly = canSign(wallet) && (t.presigned.length > 0 || !canSignAndSend(wallet));
      if (useSignOnly) {
        const signedBytes = await sign(wallet, account, current.env.cluster, bytes);
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
        signature = await sendRaw(r0.rpcUrl, signed.serialize());
      } else {
        signature = base58(await signAndSend(wallet, account, current.env.cluster, bytes));
      }

      update(i, { step: "confirming", signature });
      setAnnounce(`Transaction ${i + 1} sent. Waiting for confirmation.`);
      const result = await confirm(r0.rpcUrl, signature, t.lastValidBlockHeight);
      if (result.status === "confirmed") {
        update(i, { step: "confirmed" });
        setAnnounce(`Transaction ${i + 1} confirmed.`);
        // Anything that waited on this one can be refreshed and simulated now.
        current.env.transactions.forEach((next, j) => {
          if (next.dependsOn.includes(i)) void prepare(j);
        });
      } else if (result.status === "expired") {
        update(i, { step: "expired", error: `It didn't land before the blockhash expired. ${REBUILD}` });
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
  const anyRefreshing = loaded.refreshable.some((i) => txs[i]?.step !== "confirmed");
  const usableUntil = loaded.link.builtAt !== undefined ? loaded.link.builtAt + REFRESH_MAX_AGE_SECONDS : null;
  const staleMinutes = age !== null && age > STALE_WARNING_SECONDS && !tooOld ? Math.floor(age / 60) : null;

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
        {staleMinutes !== null ? (
          <p className="sign-flag" role="status">
            This quote is {staleMinutes} minutes old. Your minimum out is still enforced.
          </p>
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
              {tooOld && loaded.refreshable.length ? (
                <strong className="sign-bad">{TOO_OLD}</strong>
              ) : strictExpiry !== null ? (
                strictExpired ? (
                  <strong className="sign-bad">Expired. {REBUILD}</strong>
                ) : secondsLeft === null ? (
                  <>
                    after block {strictExpiry.toLocaleString("en-US")}
                    {heightError ? <span className="sign-bad small"> (can&apos;t read the current block: {heightError})</span> : null}
                  </>
                ) : (
                  `in about ${secondsLeft} seconds (block ${strictExpiry.toLocaleString("en-US")})`
                )
              ) : tooOld ? (
                <strong className="sign-bad">{TOO_OLD}</strong>
              ) : anyRefreshing && usableUntil !== null ? (
                `at ${clock(usableUntil)}, ${REFRESH_MAX_AGE_SECONDS / 60} minutes after it was built. The blockhash is refreshed automatically until then.`
              ) : (
                "Nothing left to send."
              )}
              {strictExpiry !== null && !strictExpired && anyRefreshing && !tooOld && usableUntil !== null ? (
                <span className="muted small"> Later transactions refresh their blockhash until {clock(usableUntil)}.</span>
              ) : null}
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
            refreshes={isRefreshing(i)}
            onSimulate={() => void prepare(i)}
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
  /** Takes a fresh blockhash before signing. */
  refreshes: boolean;
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
        {props.refreshes && state.step !== "confirmed" ? (
          <p className="muted small">
            Only your wallet signs this one, so it takes a fresh blockhash now and again right before your wallet sees it.
            Nothing else in it changes, and it is checked and simulated again each time.
          </p>
        ) : null}
        {waiting ? (
          <p className="muted">Runs once transaction {rt.dependsOn.map((d) => d + 1).join(", ")} has confirmed.</p>
        ) : state.simulating ? (
          <p className="muted">Simulating on Solana {env.cluster}…</p>
        ) : sim ? (
          sim.ok ? (
            <p className="sign-good">Passed{sim.unitsConsumed ? `, ${sim.unitsConsumed.toLocaleString("en-US")} compute units` : ""}.</p>
          ) : sim.expired && props.refreshes ? (
            <p className="muted">The blockhash ran out; fetching a fresh one…</p>
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
