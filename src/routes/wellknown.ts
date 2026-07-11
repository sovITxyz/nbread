import { Hono } from "hono";
import type { DispatchEnv } from "../types";

/** /.well-known/nostr.json (NIP-05, CORS *). Implemented in P4. */
export const wellknownRoutes = new Hono<DispatchEnv>();

wellknownRoutes.get("/nostr.json", (c) =>
  c.json({ error: "Not implemented until P4 (NIP-05)" }, 501),
);
