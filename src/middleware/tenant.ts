import type { MiddlewareHandler } from "hono";
import type { AppEnv, Site } from "../types";
import { getUserByHandle } from "../services/users";

export type { Site };

/**
 * Tenant resolution (runs after guard): maps the normalized host to a Site.
 *
 *   host === MAIN_HOST      → c.var.site = { type: 'main' }
 *   <handle>.MAIN_HOST      → D1 lookup; claimed & not blocked
 *                             → c.var.site = { type: 'blog', user, pubkey }
 *   unclaimed or blocked    → 404
 */
export const tenant: MiddlewareHandler<AppEnv> = async (c, next) => {
  const hostname = c.var.host;
  const main = c.env.MAIN_HOST.toLowerCase();

  if (hostname === main) {
    c.set("site", { type: "main" });
    return next();
  }

  const handle = hostname.slice(0, -(main.length + 1));
  const user = await getUserByHandle(c.env, handle);
  if (!user || user.blocked) {
    return c.text("Not found", 404);
  }

  c.set("site", { type: "blog", user, pubkey: user.pubkey });
  return next();
};
