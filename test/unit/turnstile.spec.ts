// Default Turnstile verifier (the real siteverify call) with global fetch
// stubbed in-place (vitest-pool-workers runs the worker in the test isolate,
// so swapping globalThis.fetch intercepts the verifier's outbound call — no
// network in tests). Asserts the POSTed form fields and every fail-closed
// path. Route-level Turnstile logic is covered in
// test/integration/claim.spec.ts through the injectable verifier seam.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  siteverifyTurnstile,
  TURNSTILE_SITEVERIFY_URL,
} from "../../src/routes/dashboard";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Captured = { url: string; body: URLSearchParams };

function stubFetch(
  respond: () => Response | Promise<Response>,
): { captured: Captured[] } {
  const captured: Captured[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body =
      init?.body instanceof URLSearchParams
        ? init.body
        : new URLSearchParams(String(init?.body ?? ""));
    captured.push({ url, body });
    return respond();
  }) as typeof fetch;
  return { captured };
}

describe("siteverifyTurnstile (default verifier)", () => {
  it("POSTs secret + response (+ remoteip) to siteverify and accepts success:true", async () => {
    const { captured } = stubFetch(
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await expect(siteverifyTurnstile(env, "tok-123", "1.2.3.4")).resolves.toBe(
      true,
    );
    expect(captured.length).toBe(1);
    expect(captured[0]!.url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(captured[0]!.body.get("secret")).toBe(env.TURNSTILE_SECRET_KEY);
    expect(captured[0]!.body.get("response")).toBe("tok-123");
    expect(captured[0]!.body.get("remoteip")).toBe("1.2.3.4");
  });

  it("omits remoteip when the client IP is unknown", async () => {
    const { captured } = stubFetch(
      () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
    await expect(siteverifyTurnstile(env, "tok", undefined)).resolves.toBe(
      true,
    );
    expect(captured[0]!.body.has("remoteip")).toBe(false);
  });

  it("fails closed on success:false", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            "error-codes": ["invalid-input-response"],
          }),
          { status: 200 },
        ),
    );
    await expect(siteverifyTurnstile(env, "bad", undefined)).resolves.toBe(
      false,
    );
  });

  it("fails closed on non-2xx responses", async () => {
    stubFetch(() => new Response("upstream sad", { status: 503 }));
    await expect(siteverifyTurnstile(env, "tok", undefined)).resolves.toBe(
      false,
    );
  });

  it("fails closed on a non-JSON body", async () => {
    stubFetch(() => new Response("<html>???</html>", { status: 200 }));
    await expect(siteverifyTurnstile(env, "tok", undefined)).resolves.toBe(
      false,
    );
  });

  it("fails closed on network errors", async () => {
    stubFetch(() => {
      throw new TypeError("network down");
    });
    await expect(siteverifyTurnstile(env, "tok", undefined)).resolves.toBe(
      false,
    );
  });
});
