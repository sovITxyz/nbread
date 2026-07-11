/**
 * Strict HTML output allowlist pass applied after markdown rendering.
 * Guarantees: no <script>, no on*= attributes, no javascript: hrefs.
 * Implemented in P2 (rendering).
 */
export function sanitizeHtml(_html: string): string {
  throw new Error("Not implemented until P2 (rendering)");
}
