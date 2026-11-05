export interface ErrorDetails {
  status?: number;
  code?: string;
  requestId?: string;
  body?: unknown;
}

/** Any failed call to the higher.fun API or a Solana RPC. */
export class HigherError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
    this.body = details.body;
  }

  /** Whether trying the same call again could succeed. */
  get retryable(): boolean {
    return false;
  }
}

/** 400 or 422. higher.fun says why in `{error: "bad_request", message}`. */
export class ValidationError extends HigherError {}

/** 401. No route used today needs sign-in; kept for the wallet tools. */
export class AuthenticationError extends HigherError {}

/** 403. */
export class ForbiddenError extends HigherError {}

/** 404: unknown mint, wallet or route. */
export class NotFoundError extends HigherError {}

/** 429. `retryAt` is when the server said to come back, if it said. */
export class RateLimitError extends HigherError {
  readonly retryAt?: number;

  constructor(message: string, details: ErrorDetails & { retryAt?: number } = {}) {
    super(message, details);
    this.retryAt = details.retryAt;
  }

  override get retryable(): boolean {
    return true;
  }
}

/** 5xx. */
export class ServerError extends HigherError {
  override get retryable(): boolean {
    return true;
  }
}

/** No response at all: DNS, refused or reset connections. */
export class NetworkError extends HigherError {
  override get retryable(): boolean {
    return true;
  }
}

/** The call ran past its time limit. */
export class TimeoutError extends HigherError {
  override get retryable(): boolean {
    return true;
  }
}
