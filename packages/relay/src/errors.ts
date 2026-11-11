// Every refusal the relay gives: a code agents can act on, a sentence people can read, and the HTTP status.

export type RelayCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "conflict"
  | "pending"
  | "late"
  | "rate_limited"
  | "paused"
  | "refused"
  | "expired";

const STATUS: Record<RelayCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  pending: 409,
  late: 409,
  rate_limited: 429,
  paused: 503,
  refused: 403,
  expired: 410,
};

export class RelayError extends Error {
  readonly code: RelayCode;
  readonly status: number;
  constructor(code: RelayCode, message: string) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export const fail = (code: RelayCode, message: string): never => {
  throw new RelayError(code, message);
};
