import { Hono } from "hono";
import type { DispatchEnv } from "../types";

/** Dashboard: handle claim (P4), post list / settings / editor (P5). Apex only. */
export const dashboardRoutes = new Hono<DispatchEnv>();

dashboardRoutes.get("/", (c) =>
  c.json({ error: "Not implemented until P4/P5 (dashboard)" }, 501),
);
