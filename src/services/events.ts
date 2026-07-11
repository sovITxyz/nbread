import type { NostrEvent } from "../nostr/event";

/** Row shape of the `events` table. */
export type EventRow = {
  id: string;
  pubkey: string;
  kind: number;
  d_tag: string;
  created_at: number;
  content: string;
  tags: string; // JSON string[][]
  sig: string;
  raw: string; // full original event JSON
  deleted: number; // 0 | 1
};

/** List mirrored, non-deleted kind-30023 posts for a pubkey, newest first. Implemented in P3. */
export async function listPostsByPubkey(
  _env: Env,
  _pubkey: string,
  _limit?: number,
): Promise<EventRow[]> {
  throw new Error("Not implemented until P3 (ingestion)");
}

/** Get a single post by (pubkey, d_tag). Implemented in P3. */
export async function getPost(
  _env: Env,
  _pubkey: string,
  _dTag: string,
): Promise<EventRow | null> {
  throw new Error("Not implemented until P3 (ingestion)");
}

/** Parse an events row back into a NostrEvent. Implemented in P3. */
export function rowToEvent(_row: EventRow): NostrEvent {
  throw new Error("Not implemented until P3 (ingestion)");
}
