import {
  AuthenticationError,
  ForbiddenError,
  HigherError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
  type ErrorDetails,
} from "./errors.ts";

/** Never wait longer than this between attempts, whatever Retry-After says. */
const MAX_WAIT_MS = 10_000;

export interface HttpConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Extra attempts after the first, for retryable failures only. */
  retries: number;
  /** First backoff; it doubles each attempt. */
  retryDelayMs: number;
  userAgent: string;
  fetch: typeof globalThis.fetch;
}

export function createHttpConfig(opts: Partial<HttpConfig> & { baseUrl: string }): HttpConfig {
  return {
    timeoutMs: 15_000,
    retries: 2,
    retryDelayMs: 500,
    userAgent: "highwire",
    fetch: globalThis.fetch,
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
  } as HttpConfig;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: "GET" | "POST";
  path: string;
  query?: Query;
  body?: unknown;
}

/** Make a JSON request, retrying 5xx, 429, timeouts and network failures with backoff. */
export async function request<T>(config: HttpConfig, opts: RequestOptions): Promise<T> {
  const url = toUrl(config.baseUrl, opts.path, opts.query);
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": config.userAgent };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);

  for (let attempt = 0; ; attempt++) {
    let failure: HigherError;
    try {
      const res = await config.fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (res.ok) return (await res.json()) as T;
      failure = await errorFrom(res);
    } catch (err) {
      failure = err instanceof HigherError ? err : thrownToError(err, config.timeoutMs);
    }
    if (!failure.retryable || attempt >= config.retries) throw failure;
    await sleep(waitBefore(attempt, failure, config.retryDelayMs));
  }
}

function toUrl(base: string, path: string, query: Query = {}): string {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

async function errorFrom(res: Response): Promise<HigherError> {
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  const fields = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const text = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : undefined);
  const message = text("message") ?? text("error") ?? (res.statusText || `HTTP ${res.status}`);
  const details: ErrorDetails = {
    status: res.status,
    code: text("code") ?? text("error"),
    requestId: res.headers.get("x-request-id") ?? undefined,
    body: parsed,
  };

  if (res.status === 400 || res.status === 422) return new ValidationError(message, details);
  if (res.status === 401) return new AuthenticationError(message, details);
  if (res.status === 403) return new ForbiddenError(message, details);
  if (res.status === 404) return new NotFoundError(message, details);
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    const retryAt = Number.isFinite(seconds) && res.headers.has("retry-after") ? Date.now() + seconds * 1000 : undefined;
    return new RateLimitError(message, { ...details, retryAt });
  }
  if (res.status >= 500) return new ServerError(message, details);
  return new HigherError(message, details);
}

function thrownToError(err: unknown, timeoutMs: number): HigherError {
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") return new TimeoutError(`Request timed out after ${timeoutMs}ms`);
  return new NetworkError(err instanceof Error ? err.message : "Network request failed");
}

function waitBefore(attempt: number, failure: HigherError, baseMs: number): number {
  if (failure instanceof RateLimitError && failure.retryAt !== undefined) {
    return Math.min(Math.max(failure.retryAt - Date.now(), 0), MAX_WAIT_MS);
  }
  return Math.min(baseMs * 2 ** attempt, MAX_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
