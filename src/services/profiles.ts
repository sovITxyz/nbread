import type { NostrEvent } from "../nostr/event";

/** Row shape of the `profiles` table. */
export type ProfileRow = {
  pubkey: string;
  name: string | null;
  picture: string | null;
  about: string | null;
  nip05: string | null;
  raw: string;
  updated_at: number;
};

/** Upsert a kind 0 metadata event into the profiles table. Implemented in P3. */
export async function upsertProfile(
  _env: Env,
  _ev: NostrEvent,
): Promise<void> {
  throw new Error("Not implemented until P3 (ingestion)");
}

/** Get a mirrored profile by pubkey. Implemented in P3. */
export async function getProfile(
  _env: Env,
  _pubkey: string,
): Promise<ProfileRow | null> {
  throw new Error("Not implemented until P3 (ingestion)");
}
