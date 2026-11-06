import bs58 from "bs58";
import { HigherError, NetworkError, ValidationError } from "../lib/errors.ts";
import { DEFAULT_API_URL } from "./constants.ts";

// A signed-in session with higher.fun's API, for the calls its create page makes after the wallet signs in: image and
// metadata uploads, and resolving an X or GitHub handle to the wallet that receives a coin's fees. Signing in means
// the wallet signs higher.fun's Sign-In With Solana message, so only the local signer (which holds the key) can do it;
// the hosted endpoint never can. The message is checked to be exactly higher.fun's before it's signed: a signature is
// never given for anything else.

/** The domain the sign-in message names. higher.fun's site checks the same. */
export const SIGN_IN_DOMAIN = "higher.fun";
/** How far a sign-in message's issue time may be from now. */
const MAX_SKEW_MS = 10 * 60 * 1000;

/** higher.fun's sign-in message, built exactly as its site builds it to check the server's. */
export function signInMessage(wallet: string, nonce: string, issuedAt: string): string {
  return [
    `${SIGN_IN_DOMAIN} wants you to sign in with your Solana account:`,
    wallet,
    "\nSign in to higher.fun. This does not send a transaction or cost anything.\n",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

/** Throws unless `message` is higher.fun's sign-in message for `wallet`, issued around now. Returns its nonce. */
export function checkSignInMessage(message: string, wallet: string, now = Date.now()): { nonce: string; issuedAt: string } {
  const nonce = /\nNonce: ([0-9a-f]{16,64})\n/.exec(message)?.[1];
  const issuedAt = /\nIssued At: (\S+)$/.exec(message)?.[1];
  if (!nonce || !issuedAt || message !== signInMessage(wallet, nonce, issuedAt)) {
    throw new ValidationError("That isn't higher.fun's sign-in message for this wallet, so it wasn't signed.", { code: "bad_sign_in" });
  }
  const at = Date.parse(issuedAt);
  if (Number.isNaN(at) || Math.abs(now - at) > MAX_SKEW_MS) {
    throw new ValidationError("higher.fun's sign-in message isn't from just now, so it wasn't signed.", { code: "bad_sign_in" });
  }
  return { nonce, issuedAt };
}

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface CoinMetadataInput {
  name: string;
  ticker: string;
  description: string;
  website?: string;
  x?: string;
  telegram?: string;
  feeRecipient?: { provider: "x" | "github"; handle: string };
  imageUri: string;
}

export interface FeeRecipient {
  provider: "x" | "github";
  handle: string;
  wallet: string;
}

export class HigherSession {
  private cookie: string | null = null;

  constructor(
    private readonly baseUrl = DEFAULT_API_URL,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  get signedIn(): boolean {
    return this.cookie !== null;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", ...(this.cookie ? { cookie: this.cookie } : {}), ...(init.headers as Record<string, string>) },
      });
    } catch (err) {
      throw new NetworkError(`higher.fun's API is unreachable (${err instanceof Error ? err.name : "network error"})`);
    }
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!res.ok) {
      throw new HigherError(body?.message ? `higher.fun: ${body.message}` : `higher.fun answered HTTP ${res.status}`, {
        status: res.status,
        code: body?.error ?? `http_${res.status}`,
      });
    }
    const cookies = res.headers.getSetCookie?.() ?? [];
    if (cookies.length) this.cookie = cookies.map((c) => c.split(";")[0]!.trim()).join("; ");
    return body as T;
  }

  private json<T>(path: string, payload: unknown): Promise<T> {
    return this.call<T>(path, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  }

  /** Signs in as `wallet`: asks for a nonce, checks the message is higher.fun's, has `sign` sign it, verifies. */
  async signIn(wallet: string, sign: SignMessage): Promise<void> {
    const { nonce, message } = await this.json<{ nonce: string; message: string }>("/auth/nonce", { wallet });
    const checked = checkSignInMessage(message, wallet);
    if (checked.nonce !== nonce) throw new ValidationError("higher.fun's sign-in nonce doesn't match its message, so it wasn't signed.", { code: "bad_sign_in" });
    const signature = await sign(new TextEncoder().encode(message));
    const me = await this.json<{ wallet: string }>("/auth/verify", { wallet, nonce, signature: bs58.encode(signature) });
    if (me.wallet !== wallet) throw new HigherError("higher.fun signed in a different wallet", { code: "bad_sign_in" });
    if (!this.cookie) throw new HigherError("higher.fun didn't start a session", { code: "bad_sign_in" });
  }

  /** Uploads a coin image (PNG, JPEG, GIF or WebP); returns its IPFS URI. */
  async uploadImage(bytes: Uint8Array, filename: string, type: string): Promise<string> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type }), filename);
    return (await this.call<{ imageUri: string }>("/uploads/image", { method: "POST", body: form })).imageUri;
  }

  /** Uploads the coin's metadata JSON; returns its URI for the launch. */
  async uploadMetadata(input: CoinMetadataInput): Promise<string> {
    return (await this.json<{ metadataUri: string }>("/uploads/metadata", input)).metadataUri;
  }

  /** The wallet higher.fun pays an X or GitHub account's creator fees to (it holds it until they claim). */
  resolveFeeRecipient(provider: "x" | "github", handle: string): Promise<FeeRecipient> {
    return this.json<FeeRecipient>("/fee-recipients/resolve", { provider, handle });
  }
}
