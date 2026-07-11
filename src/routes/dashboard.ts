import { Hono } from "hono";
import type { Context } from "hono";
import type { DispatchEnv } from "../types";
import { npubEncode } from "../nostr/nip19";
import {
  ClaimError,
  claimHandle,
  getUserByPubkey,
  HANDLE_REGEX,
} from "../services/users";
import { rateLimitAllows } from "../services/ratelimit";
import { DashboardPage } from "../views/main/dashboard";

/**
 * Dashboard (apex only, session required): P4 ships the minimal authed shell
 * — npub display + handle claim. Post list / settings / editor arrive in P5.
 */
export const dashboardRoutes = new Hono<DispatchEnv>();

/** Claim rate limit: 3 per hour per IP (D1 rate_limits, fixed window). */
const CLAIM_MAX = 3;
const CLAIM_WINDOW_SECONDS = 60 * 60;

// --- Turnstile ---------------------------------------------------------------

export const TURNSTILE_SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Injectable verifier seam: tests swap the network call for a fake
 * (vitest-pool-workers runs the worker in the test isolate, so module state
 * is shared — same pattern as the relay socket factory). Production always
 * uses siteverifyTurnstile below.
 */
export type TurnstileVerifier = (
  env: Env,
  token: string,
  remoteIp?: string,
) => Promise<boolean>;

/**
 * Real Cloudflare siteverify call. Fails closed on network errors, non-2xx
 * responses, and non-JSON bodies. With the official test secret
 * `1x0000000000000000000000000000000AA` (.dev.vars.example) siteverify
 * always reports success — used for local dev; tests inject a fake instead
 * (no network in tests).
 */
export const siteverifyTurnstile: TurnstileVerifier = async (
  env,
  token,
  remoteIp,
) => {
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token,
  });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body,
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch (err) {
    console.error("turnstile siteverify failed:", err);
    return false;
  }
};

let turnstileVerifier: TurnstileVerifier = siteverifyTurnstile;

/** TEST ONLY: swap the Turnstile verifier. Pass null to restore the real one. */
export function setTurnstileVerifierForTests(
  fn: TurnstileVerifier | null,
): void {
  turnstileVerifier = fn ?? siteverifyTurnstile;
}

// --- Routes --------------------------------------------------------------------

function clientIp(c: Context<DispatchEnv>): string {
  return c.req.header("CF-Connecting-IP") ?? "unknown";
}

async function renderDashboard(
  c: Context<DispatchEnv>,
  pubkey: string,
  error: string | null,
  status: 200 | 400 | 403 | 409 | 429,
) {
  const user = await getUserByPubkey(c.env, pubkey);
  return c.html(
    DashboardPage({
      npub: npubEncode(pubkey),
      handle: user?.handle ?? null,
      mainHost: c.env.MAIN_HOST.toLowerCase(),
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
      error,
    }),
    status,
  );
}

dashboardRoutes.get("/", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.redirect("/login", 302);
  return renderDashboard(c, sess.pubkey, null, 200);
});

const CLAIM_ERROR_RESPONSES: Record<
  ClaimError["code"],
  { status: 400 | 409; message: string }
> = {
  invalid: {
    status: 400,
    message:
      "Handles are 2–31 characters: lowercase letters, digits, and hyphens (must start and end with a letter or digit).",
  },
  reserved: { status: 400, message: "That handle is reserved." },
  taken: { status: 409, message: "That handle is already taken." },
  already_claimed: {
    status: 409,
    message: "Your key already has a handle — one handle per key.",
  },
};

dashboardRoutes.post("/claim", async (c) => {
  const sess = c.var.session;
  if (!sess) return c.json({ error: "authentication required" }, 401);

  // Rate limit before anything costly (every attempt counts, denied included).
  const ip = clientIp(c);
  if (
    !(await rateLimitAllows(
      c.env,
      `claim:ip:${ip}`,
      CLAIM_MAX,
      CLAIM_WINDOW_SECONDS,
    ))
  ) {
    return renderDashboard(
      c,
      sess.pubkey,
      "Too many claim attempts — try again later.",
      429,
    );
  }

  const user = await getUserByPubkey(c.env, sess.pubkey);
  if (user?.blocked) {
    return renderDashboard(c, sess.pubkey, "This account is blocked.", 403);
  }

  const body = await c.req.parseBody();
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  const turnstileToken =
    typeof body["cf-turnstile-response"] === "string"
      ? body["cf-turnstile-response"]
      : "";

  // Cheap shape check before the Turnstile subrequest.
  if (!HANDLE_REGEX.test(handle)) {
    return renderDashboard(
      c,
      sess.pubkey,
      CLAIM_ERROR_RESPONSES.invalid.message,
      400,
    );
  }

  if (
    turnstileToken === "" ||
    !(await turnstileVerifier(
      c.env,
      turnstileToken,
      c.req.header("CF-Connecting-IP"),
    ))
  ) {
    return renderDashboard(
      c,
      sess.pubkey,
      "Human verification failed — please retry the challenge.",
      403,
    );
  }

  try {
    await claimHandle(c.env, sess.pubkey, handle);
  } catch (err) {
    if (err instanceof ClaimError) {
      const { status, message } = CLAIM_ERROR_RESPONSES[err.code];
      return renderDashboard(c, sess.pubkey, message, status);
    }
    throw err;
  }
  return c.redirect("/dashboard", 303);
});
