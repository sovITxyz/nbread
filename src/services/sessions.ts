/**
 * Sessions contract: cookie `sid` host-only on MAIN_HOST; KV `sess:<token>` →
 * {pubkey, iat}, TTL 90 days.
 *
 * Tokens are 32 random bytes (crypto.getRandomValues) as 64 lowercase hex
 * chars, minted server-side ONLY — a client-supplied session id is never
 * written to KV (fixation defense: login always rotates to a fresh token).
 */
import { bytesToHex } from "@noble/hashes/utils.js";

export type Session = { pubkey: string; iat: number };

export const SESSION_COOKIE = "sid";
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60; // 90d

const TOKEN_REGEX = /^[0-9a-f]{64}$/;
const PUBKEY_REGEX = /^[0-9a-f]{64}$/;

/** KV key for a session token. Exported for tests. */
export function sessionKey(token: string): string {
  return `sess:${token}`;
}

/** Mint a fresh session token for a pubkey and persist it to KV. */
export async function createSession(env: Env, pubkey: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = bytesToHex(bytes);
  const session: Session = { pubkey, iat: Math.floor(Date.now() / 1000) };
  await env.KV.put(sessionKey(token), JSON.stringify(session), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

/**
 * Resolve a token to its session, or null. The token is shape-checked before
 * the KV read so garbage cookies never build KV keys; the stored value is
 * revalidated on the way out (defense in depth against a corrupted row).
 */
export async function getSession(
  env: Env,
  token: string,
): Promise<Session | null> {
  if (!TOKEN_REGEX.test(token)) return null;
  const raw = await env.KV.get(sessionKey(token));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.pubkey !== "string" ||
      !PUBKEY_REGEX.test(parsed.pubkey) ||
      typeof parsed.iat !== "number"
    ) {
      return null;
    }
    return { pubkey: parsed.pubkey, iat: parsed.iat };
  } catch {
    return null;
  }
}

/** Invalidate a session server-side (logout). Safe on unknown tokens. */
export async function destroySession(env: Env, token: string): Promise<void> {
  if (!TOKEN_REGEX.test(token)) return;
  await env.KV.delete(sessionKey(token));
}
