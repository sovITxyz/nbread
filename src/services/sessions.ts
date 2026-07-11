/**
 * Sessions contract: cookie `sid` host-only on MAIN_HOST; KV `sess:<token>` →
 * {pubkey, iat}, TTL 90 days. Implemented in P4 (auth).
 */

export type Session = { pubkey: string; iat: number };

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d

export async function createSession(
  _env: Env,
  _pubkey: string,
): Promise<string> {
  throw new Error("Not implemented until P4 (auth)");
}

export async function getSession(
  _env: Env,
  _token: string,
): Promise<Session | null> {
  throw new Error("Not implemented until P4 (auth)");
}

export async function destroySession(
  _env: Env,
  _token: string,
): Promise<void> {
  throw new Error("Not implemented until P4 (auth)");
}
