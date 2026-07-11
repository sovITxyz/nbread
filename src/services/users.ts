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
 * Handle shape: lowercase letters/digits with interior hyphens, 2–31 chars,
 * both ends alphanumeric.
 *
 * P4 review addendum (tightens the contract regex `^[a-z0-9][a-z0-9-]{1,30}$`,
 * pending orchestrator ratification): the contract shape admitted trailing
 * hyphens ("ab-"), but the host guard's RFC-1035 DNS_LABEL rejects them —
 * a claimed "ab-" would burn the key's ONE allowed handle on a subdomain the
 * guard 404s forever, irrecoverably (one handle per pubkey). Aligned with
 * guard.ts DNS_LABEL so every claimable handle is a routable host label.
 */
export const HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$/;

export type ClaimErrorCode =
  | "invalid" // fails HANDLE_REGEX
  | "reserved" // in reserved_handles
  | "taken" // another pubkey holds it (UNIQUE COLLATE NOCASE)
  | "already_claimed"; // this pubkey already holds a handle

/** Typed rejection from claimHandle — routes map codes to friendly errors. */
export class ClaimError extends Error {
  constructor(public readonly code: ClaimErrorCode) {
    super(`handle claim rejected: ${code}`);
    this.name = "ClaimError";
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes("UNIQUE constraint failed")
  );
}

/**
 * Claim a handle for a pubkey. Throws ClaimError on every rejection path.
 *
 * Race safety comes from the schema, not from pre-checks: concurrent claims
 * of the same handle by different pubkeys both reach the INSERT, and the
 * UNIQUE(handle COLLATE NOCASE) constraint lets exactly one win — the loser
 * surfaces as ClaimError("taken"). One-handle-per-pubkey is enforced by the
 * upsert's `WHERE users.handle IS NULL` guard: if this pubkey already holds
 * a handle (same or different), the update matches nothing and RETURNING is
 * empty → ClaimError("already_claimed").
 */
export async function claimHandle(
  env: Env,
  pubkey: string,
  handle: string,
): Promise<User> {
  if (!HANDLE_REGEX.test(handle)) throw new ClaimError("invalid");
  const reserved = await env.DB.prepare(
    "SELECT 1 FROM reserved_handles WHERE handle = ?",
  )
    .bind(handle)
    .first();
  if (reserved) throw new ClaimError("reserved");
  let row: User | null;
  try {
    row = await env.DB.prepare(
      `INSERT INTO users (pubkey, handle, claimed_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(pubkey) DO UPDATE SET
         handle = excluded.handle, claimed_at = excluded.claimed_at
         WHERE users.handle IS NULL
       RETURNING *`,
    )
      .bind(pubkey, handle, new Date().toISOString())
      .first<User>();
  } catch (err) {
    // The only UNIQUE constraint reachable here is users.handle (the pubkey
    // PK conflict is absorbed by ON CONFLICT above).
    if (isUniqueConstraintError(err)) throw new ClaimError("taken");
    throw err;
  }
  if (!row) throw new ClaimError("already_claimed");
  return row;
}
