/**
 * Sanitizer for per-blog theme CSS (user-supplied, rendered into a <style>
 * tag on every blog page).
 *
 * Threat model: the CSS author is the blog owner (semi-trusted) but the
 * value round-trips through relays/D1, so we treat it as hostile:
 *
 *   - `</style>` breakout → all `<` characters are removed (CSS needs none);
 *   - exfiltration / remote fetch → `@import`, `url(...)` removed;
 *   - legacy script vectors → `expression(...)`, `behavior:`, `-moz-binding`,
 *     `javascript:` removed;
 *   - obfuscation → backslash escapes removed first (`\75rl(` → `url(`),
 *     comments stripped (replaced by a space so they cannot join tokens),
 *     removals looped to a fixpoint (`@@importimport` cannot reassemble);
 *   - control characters stripped (tab/newline kept for readability);
 *   - length capped BEFORE any other step.
 */

/** Hard cap on stored/rendered theme CSS, in UTF-16 code units. */
export const MAX_THEME_CSS_LENGTH = 20_000;

// C0 controls except \t (0x09) and \n (0x0a), plus DEL. \r is normalized
// separately before this runs.
// eslint-disable-next-line no-control-regex
const CSS_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const DANGEROUS_PATTERNS: RegExp[] = [
  /@import/gi,
  /@charset/gi,
  /@namespace/gi,
  /url\s*\(/gi,
  /image-set\s*\(/gi,
  /expression\s*\(/gi,
  /-moz-binding/gi,
  /behavior\s*:/gi,
  /javascript\s*:/gi,
];

/**
 * Returns theme CSS that is safe to inline inside a `<style>` element.
 * Output contains no `<`, no imports/URL fetches, and no legacy script hooks.
 */
export function sanitizeCss(css: string): string {
  let s = String(css ?? "");

  // 1. Length cap first so later passes work on bounded input.
  s = s.slice(0, MAX_THEME_CSS_LENGTH);

  // 2. Normalize newlines, then strip control chars (keep \t and \n).
  s = s.replace(/\r\n?/g, "\n").replace(CSS_CONTROL_RE, "");

  // 3. Kill backslash escapes BEFORE pattern matching (\75rl( === url().
  s = s.replace(/\\/g, "");

  // 4. Strip comments (replace with a space: in real CSS a comment is a
  //    token separator, so removal must not join adjacent tokens). Also drop
  //    an unterminated trailing comment.
  s = s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\*[\s\S]*$/, "");

  // 5. No markup breakout: CSS has no legitimate use for `<`.
  s = s.replace(/</g, "");

  // 6. Remove dangerous constructs, looping to a fixpoint so removals can
  //    never splice a new dangerous token together.
  let prev: string;
  do {
    prev = s;
    for (const re of DANGEROUS_PATTERNS) {
      s = s.replace(re, "");
    }
  } while (s !== prev);

  return s.trim();
}
