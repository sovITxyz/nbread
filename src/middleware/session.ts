import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Session middleware: resolves the `sid` cookie (host-only on MAIN_HOST) to a
 * KV-backed session. Implemented in P4 (auth). Pass-through until then.
 */
export const session: MiddlewareHandler<AppEnv> = async (_c, next) => {
  // TODO(P4): read `sid` cookie, load KV sess:<token>, set c.var session.
  await next();
};
