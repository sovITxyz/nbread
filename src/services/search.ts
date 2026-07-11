import type { EventRow } from "./events";

/**
 * FTS5 search over mirrored posts with MATCH-input sanitization (quote terms,
 * strip FTS operators). Implemented in P6 (discover + search).
 */
export async function searchPosts(
  _env: Env,
  _query: string,
  _limit?: number,
): Promise<EventRow[]> {
  throw new Error("Not implemented until P6 (discover + search)");
}
