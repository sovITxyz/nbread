/**
 * Markdown pipeline: markdown-it (+footnote/task-lists/mark/sup/sub plugins,
 * highlight.js callback, heading slug ids; `html:false` — raw HTML escaped)
 * followed by the sanitize.ts output allowlist pass. NO raw HTML passthrough.
 * Implemented in P2 (rendering).
 */
export function renderPost(_md: string): string {
  throw new Error("Not implemented until P2 (rendering)");
}
