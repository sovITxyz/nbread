/** Row shape of the `users` table. */
export type User = {
  pubkey: string;
  handle: string | null;
  claimed_at: string;
  settings: string; // JSON blob
  blocked: number; // 0 | 1
};

/** Look up a user by handle (case-insensitive via COLLATE NOCASE). */
export async function getUserByHandle(
  env: Env,
  handle: string,
): Promise<User | null> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE handle = ?")
    .bind(handle)
    .first<User>();
  return row ?? null;
}

/** Look up a user by pubkey (hex). */
export async function getUserByPubkey(
  env: Env,
  pubkey: string,
): Promise<User | null> {
  const row = await env.DB.prepare("SELECT * FROM users WHERE pubkey = ?")
    .bind(pubkey)
    .first<User>();
  return row ?? null;
}

/**
 * Claim a handle for a pubkey. Implemented in P4 (Turnstile, reserved list,
 * UNIQUE race-safety, one handle per pubkey, handle regex).
 */
export async function claimHandle(
  _env: Env,
  _pubkey: string,
  _handle: string,
): Promise<User> {
  throw new Error("Not implemented until P4 (auth + handle claim)");
}
