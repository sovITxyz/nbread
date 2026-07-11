import type { NostrEvent } from "../nostr/event";

export type MirrorResult = "stored" | "stale" | "invalid";

/**
 * Mirror a Nostr event into D1: verify → replaceable upsert (keep greater
 * created_at per (pubkey, kind, d_tag), ties broken by lower id) → kind 5
 * delete handling → FTS row maintenance → bump KV gen:<pubkey>.
 * Implemented in P3 (ingestion).
 */
export async function mirrorEvent(
  _env: Env,
  _ev: NostrEvent,
): Promise<MirrorResult> {
  throw new Error("Not implemented until P3 (ingestion)");
}
