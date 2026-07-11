/**
 * Scheduled refresh (cron every 15 min): for each claimed, non-blocked user,
 * fetch kinds 0+30023 from the configured relays since the last watermark
 * and mirror them — capped at REFRESH_VERIFY_CAP new-event verifications per
 * user per run (schnorr + render CPU stays bounded), resuming next tick via
 * a `sync.since` watermark kept in users.settings (D1 — the KV free-tier
 * write budget is reserved for sessions, nonces and gen bumps).
 */
import type { User } from "../services/users";
import { fetchEvents } from "../nostr/relay";
import { mirrorEvent } from "../services/mirror";
import { storedEventIds } from "../services/events";

/** Max NEW events verified+mirrored per user per cron run (contract: ~5). */
export const REFRESH_VERIFY_CAP = 5;

/** Relay collection deadline per user (cron wall-clock budget is generous). */
export const REFRESH_TIMEOUT_MS = 8_000;

/** Relay filter limit — a few runs' worth of backlog per fetch. */
const REFRESH_FETCH_LIMIT = 60;

/** Parse the RELAYS env var (comma-separated ws(s) URLs). */
export function relayList(env: Env): string[] {
  return env.RELAYS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Read the sync watermark from a users.settings JSON blob (0 when unset). */
export function readSince(settings: string): number {
  try {
    const parsed: unknown = JSON.parse(settings);
    if (parsed !== null && typeof parsed === "object") {
      const sync = (parsed as Record<string, unknown>).sync;
      if (sync !== null && typeof sync === "object") {
        const since = (sync as Record<string, unknown>).since;
        if (
          typeof since === "number" &&
          Number.isFinite(since) &&
          since >= 0
        ) {
          return Math.floor(since);
        }
      }
    }
  } catch {
    // malformed settings → start from 0
  }
  return 0;
}

/** Persist the watermark into users.settings, preserving unrelated keys. */
async function writeSince(
  env: Env,
  user: User,
  since: number,
): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(user.settings);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // malformed settings → rebuild from scratch
  }
  const sync =
    settings.sync !== null &&
    typeof settings.sync === "object" &&
    !Array.isArray(settings.sync)
      ? (settings.sync as Record<string, unknown>)
      : {};
  settings.sync = { ...sync, since };
  await env.DB.prepare("UPDATE users SET settings = ? WHERE pubkey = ?")
    .bind(JSON.stringify(settings), user.pubkey)
    .run();
}

/**
 * Refresh one user. Events are processed OLDEST FIRST so the watermark is a
 * true resume point: when the verification cap trips mid-batch, everything
 * up to the watermark is mirrored and the rest is refetched next tick
 * (`since` is inclusive; the boundary event comes back already-stored and
 * costs no verification).
 */
async function refreshUser(
  env: Env,
  relays: string[],
  user: User,
): Promise<void> {
  const since = readSince(user.settings);
  const filter: Record<string, unknown> = {
    kinds: [0, 30023],
    authors: [user.pubkey],
    limit: REFRESH_FETCH_LIMIT,
  };
  if (since > 0) filter.since = since;

  const events = (await fetchEvents(relays, filter, REFRESH_TIMEOUT_MS))
    .filter(
      (ev) =>
        ev.pubkey === user.pubkey && (ev.kind === 0 || ev.kind === 30023),
    )
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  if (events.length === 0) return;

  const stored = await storedEventIds(
    env,
    events.map((ev) => ev.id),
  );

  let credits = REFRESH_VERIFY_CAP;
  let watermark = since;
  for (const ev of events) {
    if (!stored.has(ev.id)) {
      if (credits === 0) break; // resume from `watermark` next tick
      credits--;
      await mirrorEvent(env, ev);
    }
    if (ev.created_at > watermark) watermark = ev.created_at;
  }
  if (watermark !== since) await writeSince(env, user, watermark);
}

/** Entry point for the scheduled handler (src/index.ts). */
export async function runRefresh(
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const users = await env.DB.prepare(
    "SELECT * FROM users WHERE handle IS NOT NULL AND blocked = 0",
  ).all<User>();
  const relays = relayList(env);
  if (relays.length === 0) return;

  for (const user of users.results) {
    try {
      await refreshUser(env, relays, user);
    } catch (err) {
      // One user's relay trouble must not sink the whole run.
      console.error(`refresh failed for ${user.pubkey}:`, err);
    }
  }
}
