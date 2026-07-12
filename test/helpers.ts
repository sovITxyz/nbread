import { env, SELF } from "cloudflare:test";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "@noble/hashes/utils.js";
import keys from "./fixtures/keys.json";
import type { NostrEvent } from "../src/nostr/event";
import { createSession } from "../src/services/sessions";

export const ALICE_PK = keys.alice.pk;
export const BOB_PK = keys.bob.pk;
export const MALLORY_PK = keys.mallory.pk;
export const ALICE_SK = keys.alice.sk;
export const BOB_SK = keys.bob.sk;
export const MALLORY_SK = keys.mallory.sk;

/** Seed alice as a claimed user (handle "alice") into the test D1. */
export async function seedAlice(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at) VALUES (?, ?, ?)",
  )
    .bind(ALICE_PK, "alice", new Date().toISOString())
    .run();
}

/** Seed a blocked user (mallory, handle "blocked") into the test D1. */
export async function seedBlockedMallory(): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (pubkey, handle, claimed_at, blocked) VALUES (?, ?, ?, 1)",
  )
    .bind(MALLORY_PK, "blocked", new Date().toISOString())
    .run();
}

/**
 * Wipe all mirror state (events, posts_fts, profiles, gen counters).
 * Storage persists across `it` blocks within a test file, so specs that
 * assert exact counts/generations reset explicitly in beforeEach.
 */
export async function resetMirrorState(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM posts_fts"),
    env.DB.prepare("DELETE FROM events"),
    env.DB.prepare("DELETE FROM profiles"),
  ]);
  await Promise.all(
    [ALICE_PK, BOB_PK, MALLORY_PK].map((pk) => env.KV.delete(`gen:${pk}`)),
  );
}

/**
 * Wipe rate-limit counters. The D1 rate_limits table persists across `it`
 * blocks within a file; auth/claim specs reset it so unrelated tests never
 * trip each other's per-IP windows.
 */
export async function resetRateLimits(): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits").run();
}

/** Wipe all users (claim specs need a clean slate per test). */
export async function resetUsers(): Promise<void> {
  await env.DB.prepare("DELETE FROM users").run();
}

/**
 * Sign a kind 22242 login event for a challenge with one of the committed
 * throwaway fixture keys (nostr-tools). Overrides let tests build the
 * rejection cases (wrong kind, stale created_at, forged fields, missing or
 * misbound relay tag — pass `relay: null` to omit the tag entirely).
 */
export function signLoginEvent(
  challenge: string,
  opts: {
    sk?: string;
    kind?: number;
    created_at?: number;
    relay?: string | null;
  } = {},
): NostrEvent {
  const tags: string[][] = [];
  if (opts.relay !== null) {
    tags.push(["relay", opts.relay ?? "wss://nostrbook.net"]);
  }
  tags.push(["challenge", challenge]);
  return finalizeEvent(
    {
      kind: opts.kind ?? 22242,
      created_at: opts.created_at ?? Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/** Fetch a login challenge nonce from the worker. */
export async function getChallenge(ip = "10.0.0.1"): Promise<string> {
  const res = await SELF.fetch("https://nostrbook.net/login/challenge", {
    headers: { "CF-Connecting-IP": ip },
  });
  if (res.status !== 200) {
    throw new Error(`challenge request failed: ${res.status}`);
  }
  const body = (await res.json()) as { challenge: string };
  return body.challenge;
}

/** POST a login event to /login. */
export function postLogin(
  event: unknown,
  opts: { ip?: string; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": opts.ip ?? "10.0.0.1",
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return SELF.fetch("https://nostrbook.net/login", {
    method: "POST",
    headers,
    body: typeof event === "string" ? event : JSON.stringify(event),
  });
}

/**
 * Mint a real KV-backed session for a pubkey and return the Cookie header
 * value. P5 dashboard/editor/API specs authenticate with this.
 */
export async function sessionCookieFor(pubkey: string): Promise<string> {
  const token = await createSession(env, pubkey);
  return `sid=${token}`;
}

/**
 * Sign a kind 30023 long-form post with a committed fixture key
 * (nostr-tools). Mirrors the tag shape public/js/editor.js produces:
 * d + title + published_at (+ summary when given).
 */
export function signPostEvent(opts: {
  sk?: string;
  d: string;
  title: string;
  summary?: string;
  content: string;
  created_at: number;
  published_at?: number;
}): NostrEvent {
  const tags: string[][] = [
    ["d", opts.d],
    ["title", opts.title],
    ["published_at", String(opts.published_at ?? opts.created_at)],
  ];
  if (opts.summary !== undefined) tags.push(["summary", opts.summary]);
  return finalizeEvent(
    {
      kind: 30023,
      created_at: opts.created_at,
      tags,
      content: opts.content,
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/**
 * Sign a kind 5 delete with a committed fixture key. Mirrors editor.js:
 * e-tag the stored event id, a-tag the replaceable address.
 */
export function signDeleteEvent(opts: {
  sk?: string;
  eventId?: string;
  address?: string;
  created_at: number;
}): NostrEvent {
  const tags: string[][] = [];
  if (opts.eventId !== undefined) tags.push(["e", opts.eventId]);
  if (opts.address !== undefined) tags.push(["a", opts.address]);
  return finalizeEvent(
    {
      kind: 5,
      created_at: opts.created_at,
      tags,
      content: "Deleted via Nostrbook",
    },
    hexToBytes(opts.sk ?? ALICE_SK),
  ) as NostrEvent;
}

/** All real tags (`<...>`) in an HTML string. Escaped text can't contain `<`. */
export function extractTags(html: string): string[] {
  return html.match(/<[a-zA-Z/!][^>]*>?/g) ?? [];
}

/**
 * Scan HTML output for XSS vectors. Returns a list of offending findings
 * (empty = clean). Checks:
 *   - forbidden elements anywhere (script/iframe/object/embed/form/style...);
 *   - on* attributes inside any tag;
 *   - javascript:/vbscript:/data: URLs in href/src attributes.
 * Text-level occurrences of e.g. "onerror=" or "javascript:" are fine — they
 * are inert once the `<` that would open a tag is escaped.
 */
export function findXssVectors(
  html: string,
  mode: "fragment" | "page" = "fragment",
): string[] {
  const findings: string[] = [];
  const lower = html.toLowerCase();
  // A full page legitimately contains <style> (sanitized theme CSS), <link>
  // and <meta> from the layout; sanitized post FRAGMENTS may contain none.
  const forbidden =
    mode === "fragment"
      ? [
          "<script",
          "<iframe",
          "<object",
          "<embed",
          "<form",
          "<style",
          "<svg",
          "<math",
          "<base",
          "<link",
          "<meta",
        ]
      : ["<script", "<iframe", "<object", "<embed", "<form", "<svg", "<math", "<base"];
  for (const el of forbidden) {
    if (lower.includes(el)) findings.push(`forbidden element: ${el}`);
  }
  for (const tag of extractTags(html)) {
    if (/\son[a-z0-9]+\s*=/i.test(tag)) {
      findings.push(`event handler attr in tag: ${tag}`);
    }
    if (
      /(?:href|src|action|formaction|xlink:href|data)\s*=\s*["']?\s*(?:javascript|vbscript|data)\s*:/i.test(
        tag,
      )
    ) {
      findings.push(`dangerous URL in tag: ${tag}`);
    }
  }
  return findings;
}
