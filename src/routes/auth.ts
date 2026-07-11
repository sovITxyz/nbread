import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DispatchEnv } from "../types";
import { isNostrEvent, verifyEvent } from "../nostr/event";
import {
  createSession,
  destroySession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../services/sessions";
import { rateLimitAllows } from "../services/ratelimit";
import { LoginPage } from "../views/main/login";

/**
 * NIP-07 / kind 22242 challenge-response login (apex only).
 *
 * Flow: GET /login/challenge issues a single-use nonce (KV, 5min TTL) →
 * the browser signs a kind 22242 event carrying ['challenge', nonce] and a
 * ['relay', wss://<host>] service-binding tag via window.nostr
 * (public/js/login.js) → POST /login verifies structure, kind, created_at
 * window, relay binding, nonce, and schnorr signature, then mints a session.
 */
export const authRoutes = new Hono<DispatchEnv>();

/** Login auth-event kind (NIP-42 ephemeral auth). */
export const LOGIN_EVENT_KIND = 22242;
/** Nonce lifetime in KV. */
export const NONCE_TTL_SECONDS = 300; // 5 min
/** Accepted |created_at - now| skew on the login event. */
export const MAX_LOGIN_SKEW_SECONDS = 600; // ±10 min
/** Rate limits (D1 rate_limits table via checkRateLimit — NOT KV). */
const LOGIN_MAX = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
// Login itself only permits 10/15min/IP, so extra challenges buy an honest
// client nothing — they only burn KV write budget (P4 review fix; was 30).
const CHALLENGE_MAX = 10;
const CHALLENGE_WINDOW_SECONDS = 15 * 60;

// Global daily challenge budget (P4 review fix). Every issued challenge is a
// KV put (and each consumed nonce a KV delete); the free-tier KV budget is
// 1,000 writes/day TOTAL, shared with sessions and cache gen bumps. Without
// a global cap, a handful of IPs could legally exhaust it and break login +
// cache invalidation platform-wide. 500 puts + up to 500 deletes = the whole
// budget in the worst case, but nonce issuance stops BEFORE session writes
// start failing. Same D1 rate_limits pattern as the P3 npub mirror budget.
export const CHALLENGE_GLOBAL_DAILY_CAP = 500;
/** rate_limits key for the global challenge budget. Exported for tests. */
export const CHALLENGE_GLOBAL_KEY = "challenge:global";
const CHALLENGE_GLOBAL_WINDOW_SECONDS = 86_400;

const NONCE_REGEX = /^[0-9a-f]{64}$/;

/** Loopback hostnames wrangler dev serves the login page on. */
const DEV_LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Does the login event's `relay` tag bind it to THIS service? (P4 review
 * fix.) Without a binding tag, a third-party site could fetch one of our
 * challenges server-side, present it to a victim's NIP-07 extension as its
 * OWN login flow, and replay the resulting signature here for full session
 * takeover. Requiring a relay tag whose hostname is MAIN_HOST rejects events
 * signed for other services outright and surfaces the true destination in
 * the extension's signing prompt. Accepts any parseable URL (clients send
 * wss://<host>; https://<host> is tolerated) whose hostname matches.
 * Loopback hostnames are additionally accepted in development only, where
 * wrangler dev serves the login page on 127.0.0.1.
 */
export function relayTagBindsHost(tag: string, env: Env): boolean {
  let hostname: string;
  try {
    hostname = new URL(tag).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === env.MAIN_HOST.toLowerCase()) return true;
  return env.ENVIRONMENT === "development" && DEV_LOOPBACK_HOSTS.has(hostname);
}

/** KV key for a login nonce. Exported for tests. */
export function nonceKey(nonce: string): string {
  return `nonce:${nonce}`;
}

function clientIp(c: Context<DispatchEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

// --- GET /login — the login page ---------------------------------------------
authRoutes.get("/login", (c) => {
  if (c.var.session) return c.redirect("/dashboard", 302);
  return c.html(LoginPage());
});

// --- GET /login/challenge — issue a single-use nonce --------------------------
authRoutes.get("/login/challenge", async (c) => {
  // Per-IP first: a single hot IP is denied on its own counter without
  // inflating the global budget (denied requests still count, so checking
  // global first would let one abusive IP burn everyone's daily budget).
  const allowed = await rateLimitAllows(
    c.env,
    `challenge:ip:${clientIp(c)}`,
    CHALLENGE_MAX,
    CHALLENGE_WINDOW_SECONDS,
  );
  if (!allowed) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }
  // Global daily cap guards the shared KV write budget (see constant above).
  const globalAllowed = await rateLimitAllows(
    c.env,
    CHALLENGE_GLOBAL_KEY,
    CHALLENGE_GLOBAL_DAILY_CAP,
    CHALLENGE_GLOBAL_WINDOW_SECONDS,
  );
  if (!globalAllowed) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = bytesToHex(bytes);
  await c.env.KV.put(nonceKey(nonce), "1", {
    expirationTtl: NONCE_TTL_SECONDS,
  });
  return c.json(
    { challenge: nonce, ttl: NONCE_TTL_SECONDS },
    200,
    { "Cache-Control": "no-store" },
  );
});

// --- POST /login — verify the signed 22242 event → session --------------------
authRoutes.post("/login", async (c) => {
  const allowed = await rateLimitAllows(
    c.env,
    `login:ip:${clientIp(c)}`,
    LOGIN_MAX,
    LOGIN_WINDOW_SECONDS,
  );
  if (!allowed) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON" }, 400);
  }
  if (!isNostrEvent(body)) {
    return c.json({ error: "body must be a signed Nostr event" }, 400);
  }
  const ev = body;

  // Cheap structural checks first; schnorr (the expensive step) runs last.
  if (ev.kind !== LOGIN_EVENT_KIND) {
    return c.json({ error: "wrong event kind" }, 401);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(ev.created_at - now) > MAX_LOGIN_SKEW_SECONDS) {
    return c.json({ error: "created_at outside the acceptance window" }, 401);
  }
  const challenge = ev.tags.find((t) => t[0] === "challenge")?.[1];
  if (challenge === undefined || !NONCE_REGEX.test(challenge)) {
    return c.json({ error: "missing or malformed challenge tag" }, 401);
  }
  // Service binding (P4 review fix): the signed event must name THIS host,
  // or it was produced for (or phished through) some other service' login
  // flow — reject before touching KV. See relayTagBindsHost.
  const relayTag = ev.tags.find((t) => t[0] === "relay")?.[1];
  if (relayTag === undefined || !relayTagBindsHost(relayTag, c.env)) {
    return c.json({ error: "missing or wrong relay binding tag" }, 401);
  }

  const key = nonceKey(challenge);
  const stored = await c.env.KV.get(key);
  if (stored === null) {
    return c.json({ error: "unknown or expired challenge" }, 401);
  }
  // Single-use: consume the nonce BEFORE signature verification, so a nonce
  // is burned by its first presentation no matter how that attempt ends,
  // and a failed forgery can't retry against it.
  //
  // KNOWN RESIDUAL (P4 review, accepted): KV get→delete is not atomic and KV
  // is eventually consistent (deletes can take ~60s to propagate across
  // colos), so two POSTs presenting the SAME captured signed event inside
  // that window can both mint a session — single-use is best-effort, not
  // strict. Exploiting it requires possession of the victim's signed event
  // (TLS break / client compromise) and yields sessions only for that same
  // pubkey. Strict single-use needs the nonce store moved to D1 (atomic
  // `DELETE ... RETURNING`, one row wins) — that is a contract change (the
  // P4 brief mandates "nonce in KV"), deferred to the orchestrator.
  await c.env.KV.delete(key);

  if (!(await verifyEvent(ev))) {
    return c.json({ error: "invalid event signature" }, 401);
  }

  // Rotate: ALWAYS a fresh server-minted token. Whatever `sid` the client
  // sent is ignored and overwritten (session fixation defense).
  const token = await createSession(c.env, ev.pubkey);
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_TTL_SECONDS,
    // No `domain` attribute: host-only on MAIN_HOST per contract.
  });
  return c.json({ ok: true, pubkey: ev.pubkey }, 200, {
    "Cache-Control": "no-store",
  });
});

// --- POST /logout — invalidate server-side, clear cookie -----------------------
authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
