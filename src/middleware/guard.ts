import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Host guard: classifies the request Host header before anything else runs.
 *
 * Accepted host classes:
 *   - MAIN_HOST exactly (e.g. nostrbook.net)          → passes, host=MAIN_HOST
 *   - single-label subdomain (alice.nostrbook.net)    → passes, host as-is
 *   - localhost / 127.0.0.1 (wrangler dev)            → treated as MAIN_HOST
 * Everything else (nostrbook.net.evil.com, deep.sub.nostrbook.net, missing
 * host, unrelated domains) → 404.
 *
 * Sets c.var.host to the normalized hostname (lowercase, no port).
 */
export const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
  let raw = c.req.header("host") ?? new URL(c.req.url).host;

  // DEV ONLY: wrangler dev's proxy rewrites the Host header to the first
  // configured route, which makes subdomains untestable locally. When (and
  // only when) ENVIRONMENT === "development", allow X-Forwarded-Host to
  // override so `curl -H 'X-Forwarded-Host: alice.nostrbook.net'` works.
  // In production this header is ignored entirely (it is client-spoofable).
  if (c.env.ENVIRONMENT === "development") {
    const forwarded = c.req.header("x-forwarded-host");
    if (forwarded) raw = forwarded;
  }

  const hostname = raw.toLowerCase().split(":")[0] ?? "";
  const main = c.env.MAIN_HOST.toLowerCase();

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    // wrangler dev convenience: treat the loopback host as the apex.
    c.set("host", main);
    return next();
  }

  if (hostname === main) {
    c.set("host", hostname);
    return next();
  }

  if (hostname.endsWith("." + main)) {
    const label = hostname.slice(0, -(main.length + 1));
    // Only single-label subdomains are valid blog hosts.
    if (label.length > 0 && !label.includes(".")) {
      c.set("host", hostname);
      return next();
    }
  }

  // Unknown / spoofed host class (e.g. nostrbook.net.evil.com).
  return c.text("Not found", 404);
};
