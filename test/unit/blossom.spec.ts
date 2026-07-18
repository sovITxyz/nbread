// Blossom uploader — PURE helper coverage. The two IIFEs are imported for
// their side effect (nostr-crypto assigns globalThis.NbreadCrypto, which
// blossom.js's base64url encoder depends on; blossom assigns
// globalThis.NbreadBlossom). Only the network-free helpers are exercised
// here — uploadBlob() (fetch + crypto.subtle) is covered by the integration
// surface, never unit-tested.
import { describe, expect, it } from "vitest";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/vendor/nostr-crypto.js";
// @ts-ignore — plain browser IIFE, intentionally shipped without types
import "../../public/js/blossom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const crypto = (globalThis as any).NbreadCrypto as {
  base64Decode: (s: string) => Uint8Array;
  utf8Decode: (b: Uint8Array) => string;
};

const blossom = (globalThis as any).NbreadBlossom as {
  BLOSSOM_SERVERS: string[];
  buildAuthEvent: (
    shaHex: string,
    sec: number,
  ) => { kind: number; created_at: number; content: string; tags: string[][] };
  encodeAuthHeader: (signed: unknown) => string;
  validateFile: (
    file: unknown,
    opts?: { maxBytes?: number; types?: string[] },
  ) => { ok: boolean; reason?: string };
  isHttpsUrl: (u: unknown) => boolean;
  extForType: (mime: string) => string;
  uploadBlob: (file: unknown, opts?: unknown) => Promise<unknown>;
};

/** Reverse of blossom's base64url(no-pad) so we can round-trip the header. */
function fromBase64Url(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return crypto.utf8Decode(crypto.base64Decode(b64));
}

describe("blossom is loaded", () => {
  it("assigns the API to globalThis", () => {
    expect(blossom).toBeDefined();
    expect(typeof blossom.uploadBlob).toBe("function");
    expect(typeof blossom.buildAuthEvent).toBe("function");
  });

  it("exposes the four Blossom servers, primary first", () => {
    expect(blossom.BLOSSOM_SERVERS).toEqual([
      "https://blossom.band",
      "https://blossom.nostr.build",
      "https://nostr.download",
      "https://cdn.nostrcheck.me",
    ]);
  });
});

describe("buildAuthEvent", () => {
  const sha = "ab".repeat(32); // 64 lowercase hex chars

  it("builds the kind-24242 'Upload Blob' template with the right tags", () => {
    const now = 1_700_000_000;
    const ev = blossom.buildAuthEvent(sha, now);
    expect(ev.kind).toBe(24242);
    expect(ev.created_at).toBe(now);
    expect(ev.content).toBe("Upload Blob");
    expect(ev.tags).toContainEqual(["t", "upload"]);
    expect(ev.tags).toContainEqual(["x", sha]);
    expect(ev.tags).toContainEqual(["expiration", String(now + 300)]);
  });

  it("stamps created_at at the given second and never in the future", () => {
    const now = Math.floor(Date.now() / 1000);
    const ev = blossom.buildAuthEvent(sha, now);
    expect(ev.created_at).toBe(now);
    expect(ev.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    // expiration is strictly after created_at.
    const exp = ev.tags.find((t) => t[0] === "expiration")!;
    expect(Number(exp[1])).toBeGreaterThan(ev.created_at);
  });
});

describe("encodeAuthHeader", () => {
  it("produces 'Nostr <base64url-no-pad>' that decodes back to the event", () => {
    const signed = {
      id: "f".repeat(64),
      pubkey: "0".repeat(64),
      kind: 24242,
      created_at: 1_700_000_000,
      content: "Upload Blob",
      tags: [["t", "upload"]],
      sig: "1".repeat(128),
    };
    const header = blossom.encodeAuthHeader(signed);
    expect(header.slice(0, 6)).toBe("Nostr ");
    // Exactly one space after "Nostr".
    expect(header[6]).not.toBe(" ");
    const b64url = header.slice(6);
    // base64url alphabet, no padding.
    expect(b64url).not.toMatch(/[+/=]/);
    expect(JSON.parse(fromBase64Url(b64url))).toEqual(signed);
  });
});

describe("validateFile", () => {
  const allowed = ["image/png", "image/jpeg", "image/webp", "image/gif"];

  it("accepts each allowed image type under the cap", () => {
    for (const type of allowed) {
      expect(blossom.validateFile({ type, size: 1024 }).ok).toBe(true);
    }
  });

  it("rejects an oversized file", () => {
    const res = blossom.validateFile({
      type: "image/png",
      size: 21 * 1024 * 1024,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/large/i);
  });

  it("honors a custom maxBytes", () => {
    expect(
      blossom.validateFile({ type: "image/png", size: 100 }, { maxBytes: 50 })
        .ok,
    ).toBe(false);
    expect(
      blossom.validateFile({ type: "image/png", size: 40 }, { maxBytes: 50 }).ok,
    ).toBe(true);
  });

  it("rejects a disallowed type (incl. svg, which is an XSS vector)", () => {
    expect(blossom.validateFile({ type: "image/svg+xml", size: 10 }).ok).toBe(
      false,
    );
    expect(blossom.validateFile({ type: "application/pdf", size: 10 }).ok).toBe(
      false,
    );
  });

  it("rejects empty and zero-size files", () => {
    expect(blossom.validateFile({ type: "image/png", size: 0 }).ok).toBe(false);
  });

  it("rejects non-file inputs", () => {
    expect(blossom.validateFile(null).ok).toBe(false);
    expect(blossom.validateFile(undefined).ok).toBe(false);
    expect(blossom.validateFile("not a file").ok).toBe(false);
    expect(blossom.validateFile({}).ok).toBe(false);
    expect(blossom.validateFile({ type: "image/png" }).ok).toBe(false);
    expect(blossom.validateFile({ size: 100 }).ok).toBe(false);
  });
});

describe("isHttpsUrl", () => {
  it("accepts absolute https URLs", () => {
    expect(blossom.isHttpsUrl("https://blossom.band/abcd.png")).toBe(true);
    expect(blossom.isHttpsUrl("https://cdn.nostrcheck.me/x")).toBe(true);
  });

  it("rejects http, javascript:, data:, relative, and empty", () => {
    expect(blossom.isHttpsUrl("http://blossom.band/x.png")).toBe(false);
    expect(blossom.isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(blossom.isHttpsUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(blossom.isHttpsUrl("/relative/path.png")).toBe(false);
    expect(blossom.isHttpsUrl("blossom.band/x.png")).toBe(false);
    expect(blossom.isHttpsUrl("")).toBe(false);
    expect(blossom.isHttpsUrl(null)).toBe(false);
    expect(blossom.isHttpsUrl(undefined)).toBe(false);
  });

  it("rejects https URLs that would break out of the markdown destination", () => {
    // A hostile/compromised server can return a string that new URL() parses
    // as protocol https: but whose ')'/whitespace/newline terminates the
    // "![](url)" image and injects live attacker markdown after it.
    expect(
      blossom.isHttpsUrl("https://evil.com/x.png) [phish](https://evil.com)"),
    ).toBe(false);
    expect(blossom.isHttpsUrl("https://evil.com/x.png)\n\n# Injected")).toBe(
      false,
    );
    expect(blossom.isHttpsUrl("https://evil.com/x.png (title)")).toBe(false);
    expect(blossom.isHttpsUrl("https://evil.com/a b.png")).toBe(false);
    expect(blossom.isHttpsUrl('https://evil.com/x"y.png')).toBe(false);
    expect(blossom.isHttpsUrl("https://evil.com/x`y.png")).toBe(false);
  });
});

describe("extForType", () => {
  it("maps known image MIME types to extensions", () => {
    expect(blossom.extForType("image/png")).toBe("png");
    expect(blossom.extForType("image/jpeg")).toBe("jpg");
    expect(blossom.extForType("image/webp")).toBe("webp");
    expect(blossom.extForType("image/gif")).toBe("gif");
  });

  it("falls back to 'bin' for anything else", () => {
    expect(blossom.extForType("application/octet-stream")).toBe("bin");
    expect(blossom.extForType("")).toBe("bin");
  });
});
