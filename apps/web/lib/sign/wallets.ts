import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { Cluster } from "highwire-core/browser";

// Wallet Standard, the way Phantom, Solflare, Backpack and other Solana wallets
// announce themselves to a page. Only the features the signing page uses are
// typed here.

export const CONNECT = "standard:connect";
export const DISCONNECT = "standard:disconnect";
export const EVENTS = "standard:events";
export const SIGN_AND_SEND = "solana:signAndSendTransaction";
export const SIGN = "solana:signTransaction";

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }>;
}
interface DisconnectFeature {
  disconnect(): Promise<void>;
}
interface EventsFeature {
  on(event: "change", listener: (props: { accounts?: readonly WalletAccount[] }) => void): () => void;
}
interface SignAndSendFeature {
  supportedTransactionVersions?: readonly (number | "legacy")[];
  signAndSendTransaction(
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array; options?: { preflightCommitment?: string; skipPreflight?: boolean } }[]
  ): Promise<readonly { signature: Uint8Array }[]>;
}
interface SignFeature {
  supportedTransactionVersions?: readonly (number | "legacy")[];
  signTransaction(...inputs: { account: WalletAccount; chain?: string; transaction: Uint8Array }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

const feature = <T,>(w: Wallet, name: string): T | undefined => (w.features as Record<string, unknown>)[name] as T | undefined;

export const chainOf = (cluster: Cluster) => `solana:${cluster}`;

/** A wallet that can connect and sign v0 transactions on Solana. */
export function isSolanaWallet(w: Wallet): boolean {
  if (!feature<ConnectFeature>(w, CONNECT)) return false;
  const v0 = (f?: { supportedTransactionVersions?: readonly (number | "legacy")[] }) =>
    !!f && (f.supportedTransactionVersions === undefined || f.supportedTransactionVersions.includes(0));
  return v0(feature<SignAndSendFeature>(w, SIGN_AND_SEND)) || v0(feature<SignFeature>(w, SIGN));
}

/** Every Solana wallet registered now, and a subscription to ones that register later. */
export function watchWallets(onChange: (wallets: Wallet[]) => void): () => void {
  const api = getWallets();
  const emit = () => onChange(api.get().filter(isSolanaWallet));
  emit();
  const offRegister = api.on("register", emit);
  const offUnregister = api.on("unregister", emit);
  return () => {
    offRegister();
    offUnregister();
  };
}

export async function connect(w: Wallet): Promise<readonly WalletAccount[]> {
  const { accounts } = await feature<ConnectFeature>(w, CONNECT)!.connect();
  return accounts.length ? accounts : w.accounts;
}

export async function disconnect(w: Wallet): Promise<void> {
  await feature<DisconnectFeature>(w, DISCONNECT)?.disconnect();
}

export function onAccountsChange(w: Wallet, listener: (accounts: readonly WalletAccount[]) => void): () => void {
  const events = feature<EventsFeature>(w, EVENTS);
  if (!events) return () => {};
  return events.on("change", (props) => {
    if (props.accounts) listener(props.accounts);
  });
}

export const canSignAndSend = (w: Wallet) => !!feature<SignAndSendFeature>(w, SIGN_AND_SEND);
export const canSign = (w: Wallet) => !!feature<SignFeature>(w, SIGN);

export async function signAndSend(w: Wallet, account: WalletAccount, cluster: Cluster, tx: Uint8Array): Promise<Uint8Array> {
  const [out] = await feature<SignAndSendFeature>(w, SIGN_AND_SEND)!.signAndSendTransaction({
    account,
    chain: chainOf(cluster),
    transaction: tx,
    options: { preflightCommitment: "confirmed" },
  });
  if (!out) throw new Error("The wallet returned no signature.");
  return out.signature;
}

export async function sign(w: Wallet, account: WalletAccount, cluster: Cluster, tx: Uint8Array): Promise<Uint8Array> {
  const [out] = await feature<SignFeature>(w, SIGN)!.signTransaction({ account, chain: chainOf(cluster), transaction: tx });
  if (!out) throw new Error("The wallet returned no signed transaction.");
  return out.signedTransaction;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58, for a transaction signature. */
export function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out.startsWith("1") && bytes.every((b) => b === 0) ? out.slice(0, bytes.length) : out;
}
