import type { NostrEvent } from "./event";

/**
 * Fetch events from a pool of relays: connect, send REQ with `filter`, collect
 * until EOSE or `timeoutMs`, dedupe by id, close. Per-relay failure isolation.
 * Implemented in P1 (nostr core).
 */
export async function fetchEvents(
  _relays: string[],
  _filter: object,
  _timeoutMs: number,
): Promise<NostrEvent[]> {
  throw new Error("Not implemented until P1 (nostr core)");
}
