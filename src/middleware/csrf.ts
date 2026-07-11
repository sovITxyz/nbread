import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * CSRF protection (Origin check) for state-changing dashboard/API requests.
 * Implemented in P5 (editor + dashboard). Pass-through until then.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (_c, next) => {
  // TODO(P5): enforce Origin === https://MAIN_HOST on POST/PUT/DELETE.
  await next();
};
