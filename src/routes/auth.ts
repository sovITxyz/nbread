import { Hono } from "hono";
import type { DispatchEnv } from "../types";

/** NIP-07 / kind 22242 login flow (apex only). Implemented in P4. */
export const authRoutes = new Hono<DispatchEnv>();

authRoutes.get("/login", (c) =>
  c.json({ error: "Not implemented until P4 (auth)" }, 501),
);

authRoutes.post("/login", (c) =>
  c.json({ error: "Not implemented until P4 (auth)" }, 501),
);

authRoutes.post("/logout", (c) =>
  c.json({ error: "Not implemented until P4 (auth)" }, 501),
);
