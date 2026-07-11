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
 * Authenticated caller set by the session middleware (main site only).
 * Null = anonymous. The pubkey is the sole identity — there are no user ids.
 */
export type SessionVar = { pubkey: string };

/**
 * Sub-apps (main vs blog) are dispatched via a sub-fetch that injects the
 * resolved Site into the env object (see src/app.ts).
 *
 * `session` is set on every main-site request by the session middleware;
 * blog-site handlers never read it (sessions are apex host-only).
 */
export type DispatchEnv = {
  Bindings: Env & { SITE: Site };
  Variables: {
    site: Site;
    session: SessionVar | null;
  };
};
