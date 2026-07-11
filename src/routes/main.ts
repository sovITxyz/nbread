import { Hono } from "hono";
import type { DispatchEnv } from "../types";
import { MainHome } from "../views/main/home";

/** Routes served on the apex (MAIN_HOST). */
export const mainRoutes = new Hono<DispatchEnv>();

mainRoutes.get("/", (c) => c.html(MainHome()));

mainRoutes.get("/healthz", (c) =>
  c.json({ ok: true, service: "nostrbook", environment: c.env.ENVIRONMENT }),
);
