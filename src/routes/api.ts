import { Hono } from "hono";
import type { DispatchEnv } from "../types";

/** JSON API (apex only). The mirror endpoint arrives in P5. */
export const apiRoutes = new Hono<DispatchEnv>();

apiRoutes.post("/mirror", (c) =>
  c.json({ error: "Not implemented until P5 (editor + dashboard)" }, 501),
);
