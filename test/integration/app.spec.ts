// End-to-end worker integration tests via SELF.fetch with Host overrides
// (the four contracted host classes) — exercises src/index.ts through the
// full guard → tenant → dispatch pipeline.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { seedAlice } from "../helpers";

describe("worker end-to-end (SELF.fetch)", () => {
  beforeAll(async () => {
    await seedAlice();
  });

  it("serves the main site on https://nostrbook.net/", async () => {
    const res = await SELF.fetch("https://nostrbook.net/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Nostrbook");
    expect(html).toContain("<html");
  });

  it("serves a healthz endpoint on the apex", async () => {
    const res = await SELF.fetch("https://nostrbook.net/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("nostrbook");
  });

  it("serves a distinct blog page on https://alice.nostrbook.net/", async () => {
    const res = await SELF.fetch("https://alice.nostrbook.net/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("@alice");
    // Distinct from the apex response:
    expect(html).not.toContain("Nostr-native blogging");
  });

  it("404s an unclaimed subdomain https://unknown.nostrbook.net/", async () => {
    const res = await SELF.fetch("https://unknown.nostrbook.net/");
    expect(res.status).toBe(404);
  });

  it("404s a spoofed host https://nostrbook.net.evil.com/", async () => {
    const res = await SELF.fetch("https://nostrbook.net.evil.com/");
    expect(res.status).toBe(404);
  });

  it("stubbed phase endpoints respond 501, not 404, on the apex", async () => {
    const login = await SELF.fetch("https://nostrbook.net/auth/login");
    expect(login.status).toBe(501);
    const nip05 = await SELF.fetch(
      "https://nostrbook.net/.well-known/nostr.json?name=alice",
    );
    expect(nip05.status).toBe(501);
  });

  it("apex routes are not exposed on blog subdomains", async () => {
    const res = await SELF.fetch("https://alice.nostrbook.net/auth/login");
    expect(res.status).toBe(404);
  });
});
