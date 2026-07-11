import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Edge cache middleware. Contract: Cache API key
 * `https://cache.internal/<host><path>?g=<gen>`, gen from KV `gen:<pubkey>`,
 * s-maxage=3600. Implemented in P3 (ingestion). Pass-through until then.
 */
export const cache: MiddlewareHandler<AppEnv> = async (_c, next) => {
  // TODO(P3): Cache API lookup/put keyed on host+path+generation.
  await next();
};
