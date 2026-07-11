import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { DispatchEnv } from "../types";
import { getSession, SESSION_COOKIE } from "../services/sessions";

/**
 * Session middleware (MAIN-SITE ROUTER ONLY — sessions are apex host-only per
 * contract): resolves the `sid` cookie to a KV-backed session and sets
 * c.var.session = { pubkey } | null. Never rejects — route handlers decide
 * what anonymous means for them (redirect to /login, 401, etc.).
 */
export const session: MiddlewareHandler<DispatchEnv> = async (c, next) => {
  c.set("session", null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const sess = await getSession(c.env, token);
    if (sess) c.set("session", { pubkey: sess.pubkey });
  }
  await next();
};
