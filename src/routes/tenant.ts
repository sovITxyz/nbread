import { Hono } from "hono";
import type { DispatchEnv } from "../types";
import { BlogHome } from "../views/tenant/home";

/** Routes served on blog subdomains (<handle>.MAIN_HOST). */
export const tenantRoutes = new Hono<DispatchEnv>();

tenantRoutes.get("/", (c) => {
  const site = c.var.site;
  if (site.type !== "blog") return c.notFound();
  return c.html(BlogHome({ user: site.user }));
});

// TODO(P2/P3): /:slug post pages, /rss.xml, /sitemap.xml, /robots.txt.
