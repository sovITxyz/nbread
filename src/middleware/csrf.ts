import type { MiddlewareHandler } from "hono";
import type { DispatchEnv } from "../types";

/** Methods that can mutate state and therefore need same-origin proof. */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Loopback origins wrangler dev serves on; treated as the apex (like guard). */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * CSRF protection for the MAIN site (applied before auth/dashboard/api
 * routes, JSON APIs included — a cookie-authed JSON POST is exactly as
 * forgeable as a form POST).
 *
 * Policy for unsafe methods:
 *   - `Sec-Fetch-Site` present → only `same-origin` (and `none`, which
 *     browsers send solely for user-initiated navigations that cannot POST
 *     cross-site) pass. `same-site` is REJECTED on purpose: blog subdomains
 *     are untrusted tenant content and must not be able to drive the apex
 *     session.
 *   - `Origin` present → its hostname must be MAIN_HOST (or a loopback host
 *     in wrangler dev, mirroring the guard's loopback-as-apex rule). The
 *     literal `Origin: null` (sandboxed iframes, some redirects) fails the
 *     URL parse and is rejected.
 *   - Neither header → allowed. Every modern browser attaches at least one
 *     of the two to cross-site POSTs; header-less unsafe requests come from
 *     non-browser clients (curl, server-to-server), which cannot be
 *     CSRF-driven because the attacker could just send the request directly.
 */
export const csrf: MiddlewareHandler<DispatchEnv> = async (c, next) => {
  if (!UNSAFE_METHODS.has(c.req.method)) return next();

  const secFetchSite = c.req.header("sec-fetch-site");
  if (
    secFetchSite !== undefined &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }

  const origin = c.req.header("origin");
  if (origin !== undefined) {
    let hostname: string | null = null;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      hostname = null; // includes the literal "null" origin
    }
    const main = c.env.MAIN_HOST.toLowerCase();
    const sameOrigin =
      hostname !== null &&
      (hostname === main || LOOPBACK_HOSTNAMES.has(hostname));
    if (!sameOrigin) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
  }

  await next();
};
