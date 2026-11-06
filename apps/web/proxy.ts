import { NextResponse, type NextRequest } from "next/server";
import { signCsp } from "./lib/sign/csp.ts";

// Only /sign: a fresh nonce per request for its Content-Security-Policy (lib/sign/csp.ts). Next.js reads the policy
// from the request headers and puts the nonce on the scripts it renders.
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = signCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: "/sign" };
