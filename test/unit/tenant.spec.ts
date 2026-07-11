// Tenant + guard middleware unit tests — all 4 host classes:
//   1. nostrbook.net            → main site
//   2. alice.nostrbook.net      → blog site (claimed handle)
//   3. unknown.nostrbook.net    → 404 (unclaimed handle)
//   4. nostrbook.net.evil.com   → 404 (spoofed host class)
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { guard } from "../../src/middleware/guard";
import { tenant } from "../../src/middleware/tenant";
import type { AppEnv } from "../../src/types";
import { seedAlice, seedBlockedMallory, ALICE_PK } from "../helpers";

/** Probe app: guard + tenant, then echo the resolved site as JSON. */
function probeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", guard);
  app.use("*", tenant);
  app.get("*", (c) => c.json(c.var.site));
  return app;
}

function req(host: string, path = "/") {
  return new Request(`https://${host}${path}`, {
    headers: { host },
  });
}

describe("guard + tenant middleware host classes", () => {
  beforeAll(async () => {
    await seedAlice();
    await seedBlockedMallory();
  });

  it("1. apex (nostrbook.net) resolves to the main site", async () => {
    const res = await probeApp().request(req("nostrbook.net"), undefined, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "main" });
  });

  it("2. claimed subdomain (alice.nostrbook.net) resolves to the blog site", async () => {
    const res = await probeApp().request(
      req("alice.nostrbook.net"),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const site = (await res.json()) as {
      type: string;
      pubkey: string;
      user: { handle: string };
    };
    expect(site.type).toBe("blog");
    expect(site.pubkey).toBe(ALICE_PK);
    expect(site.user.handle).toBe("alice");
  });

  it("3. unclaimed subdomain (unknown.nostrbook.net) is a 404", async () => {
    const res = await probeApp().request(
      req("unknown.nostrbook.net"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("4. spoofed host class (nostrbook.net.evil.com) is a 404", async () => {
    const res = await probeApp().request(
      req("nostrbook.net.evil.com"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects deep subdomains (a.b.nostrbook.net)", async () => {
    const res = await probeApp().request(
      req("a.b.nostrbook.net"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("rejects unrelated hosts (example.com)", async () => {
    const res = await probeApp().request(req("example.com"), undefined, env);
    expect(res.status).toBe(404);
  });

  it("blocked users are 404 on their subdomain", async () => {
    const res = await probeApp().request(
      req("blocked.nostrbook.net"),
      undefined,
      env,
    );
    expect(res.status).toBe(404);
  });

  it("host matching is case-insensitive and ignores ports", async () => {
    const res = await probeApp().request(
      req("ALICE.NostrBook.NET:8443"),
      undefined,
      env,
    );
    expect(res.status).toBe(200);
    const site = (await res.json()) as { type: string };
    expect(site.type).toBe("blog");
  });

  it("X-Forwarded-Host override works in development (wrangler dev aid)", async () => {
    // env.ENVIRONMENT is "development" in the test config.
    const r = new Request("http://localhost:8787/", {
      headers: {
        host: "localhost:8787",
        "x-forwarded-host": "alice.nostrbook.net",
      },
    });
    const res = await probeApp().request(r, undefined, env);
    expect(res.status).toBe(200);
    const site = (await res.json()) as { type: string };
    expect(site.type).toBe("blog");
  });

  it("X-Forwarded-Host is IGNORED outside development", async () => {
    // wrangler types narrows ENVIRONMENT to the literal "development",
    // hence the double cast to simulate production.
    const prodEnv = { ...env, ENVIRONMENT: "production" } as unknown as typeof env;
    const r = new Request("https://nostrbook.net/", {
      headers: {
        host: "nostrbook.net",
        "x-forwarded-host": "alice.nostrbook.net",
      },
    });
    const res = await probeApp().request(r, undefined, prodEnv);
    expect(res.status).toBe(200);
    // Must resolve from the real Host header (main), not the spoofed one.
    expect(await res.json()).toEqual({ type: "main" });
  });
});
