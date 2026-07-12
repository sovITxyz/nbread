import {
  DISCOVER_PAGE_SIZE,
  type FeedRow,
} from "./events";

/**
 * FTS5 search over mirrored posts (posts_fts) with strict MATCH-input
 * sanitization: user input NEVER reaches MATCH raw (P6).
 */

/** Hard cap on the raw query length considered (DoS bound). */
export const SEARCH_MAX_QUERY_CHARS = 256;

/** Hard cap on the number of terms handed to MATCH. */
export const SEARCH_MAX_TERMS = 8;

/** Max results returned per search (single page; recency-ordered). */
export const SEARCH_RESULT_LIMIT = DISCOVER_PAGE_SIZE;

/**
 * Sanitize arbitrary user input into a safe FTS5 MATCH expression.
 *
 * Strategy: extract runs of Unicode letters/digits and wrap each run in
 * double quotes (an FTS5 phrase). Everything else — quotes, `*`, `^`, `-`,
 * parentheses, `:` column filters, `+`, backslashes — is a separator and
 * never reaches MATCH. Bareword operators (AND/OR/NOT/NEAR) survive only as
 * QUOTED phrases, where FTS5 treats them as plain terms. Quoted terms are
 * joined with spaces (implicit AND).
 *
 * This mirrors what the unicode61 tokenizer would keep anyway (it splits on
 * non-alphanumerics), so stripping punctuation does not change which
 * documents can match — it only removes operator semantics.
 *
 * Returns "" when nothing searchable remains; callers must then skip MATCH
 * entirely (FTS5 rejects an empty expression with an error).
 */
export function toMatchQuery(raw: string): string {
  const capped = raw.slice(0, SEARCH_MAX_QUERY_CHARS);
  const terms = capped.match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms
    .slice(0, SEARCH_MAX_TERMS)
    .map((t) => `"${t}"`)
    .join(" ");
}

/**
 * Search mirrored posts. Results are scoped EXACTLY like the discover feed
 * (P6 trap): kind 30023 only, `deleted = 0`, author JOIN with a claimed
 * handle and `blocked = 0` — posts_fts rows for unclaimed-npub mirrors,
 * blocked authors, or tombstoned posts never surface. FTS-row hygiene
 * (applyDelete removes rows) is NOT relied on; the join re-filters.
 *
 * Ordering matches discover and is deterministic: created_at DESC, id ASC
 * tie-break (recency, not bm25 — a blog platform's "search" is closer to a
 * filtered feed, and recency ordering keeps pagination/snapshots stable).
 *
 * Never throws on hostile input: the sanitizer guarantees an operator-free
 * MATCH expression, and any residual D1/FTS error degrades to an empty
 * result set instead of a 500 on this public path.
 */
export async function searchPosts(
  env: Env,
  query: string,
  limit: number = SEARCH_RESULT_LIMIT,
): Promise<FeedRow[]> {
  const match = toMatchQuery(query);
  if (match === "") return [];
  const safeLimit = Math.min(
    Math.max(1, Math.trunc(limit) || 1),
    SEARCH_RESULT_LIMIT,
  );
  try {
    const rs = await env.DB.prepare(
      `SELECT e.*, u.handle AS handle
       FROM posts_fts
       JOIN events e ON e.rowid = posts_fts.rowid
       JOIN users u ON u.pubkey = e.pubkey
       WHERE posts_fts MATCH ?1
         AND e.kind = 30023 AND e.deleted = 0
         AND u.handle IS NOT NULL AND u.blocked = 0
       ORDER BY e.created_at DESC, e.id ASC
       LIMIT ?2`,
    )
      .bind(match, safeLimit)
      .all<FeedRow>();
    return rs.results;
  } catch (err) {
    // Defense-in-depth only — the sanitizer shape is unit-tested to be a
    // valid FTS5 expression. A real D1 outage degrades to "no results".
    console.error("search query failed:", err);
    return [];
  }
}
