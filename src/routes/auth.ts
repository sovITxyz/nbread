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
 * the browser signs a kind 22242 event carrying ['challenge', nonce] via
 * window.nostr (public/js/login.js) → POST /login verifies structure, kind,
 * created_at window, nonce, and schnorr signature, then mints a session.
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
const CHALLENGE_MAX = 30;
const CHALLENGE_WINDOW_SECONDS = 15 * 60;

const NONCE_REGEX = /^[0-9a-f]{64}$/;

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
  const allowed = await rateLimitAllows(
    c.env,
    `challenge:ip:${clientIp(c)}`,
    CHALLENGE_MAX,
    CHALLENGE_WINDOW_SECONDS,
  );
  if (!allowed) {
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

  const key = nonceKey(challenge);
  const stored = await c.env.KV.get(key);
  if (stored === null) {
    return c.json({ error: "unknown or expired challenge" }, 401);
  }
  // Single-use: consume the nonce BEFORE signature verification, so a nonce
  // is burned by its first presentation no matter how that attempt ends —
  // no replay window, and a failed forgery can't retry against it either.
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
