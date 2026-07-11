import type { User } from "./services/users";

/**
 * Site resolution result set by the tenant middleware (src/middleware/tenant.ts).
 * Contract: c.var.site = {type:'main'} | {type:'blog', user, pubkey}
 */
export type Site =
  | { type: "main" }
  | { type: "blog"; user: User; pubkey: string };

/** Hono generic for the outer app: Worker bindings + per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Normalized hostname (no port, lowercase) set by the guard middleware. */
    host: string;
    /** Site resolution set by the tenant middleware. */
    site: Site;
  };
};

/**
 * Sub-apps (main vs blog) are dispatched via a sub-fetch that injects the
 * resolved Site into the env object (see src/app.ts).
 */
export type DispatchEnv = {
  Bindings: Env & { SITE: Site };
  Variables: {
    site: Site;
  };
};
