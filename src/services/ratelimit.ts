/**
 * Fixed-window rate limiting backed by the D1 `rate_limits` table (NOT KV —
 * free-tier KV write budget is reserved for sessions/gen bumps).
 *
 * Implemented in P3 (was slated for P4): the unclaimed-npub on-demand mirror
 * needs an application-level abuse cap (global + per-IP) that the per-pubkey
 * cooldown cannot provide — an attacker bypasses per-pubkey throttles simply
 * by enumerating distinct npubs. P4 (auth + handle claim) reuses this.
 *
 * The counter is a single upsert statement, so concurrent requests cannot
 * lose increments to a read-modify-write race. Denied requests still count
 * (the window keeps filling), which is the desired behavior for abuse caps.
 */
export async function checkRateLimit(
  env: Env,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start
                    THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  // Defensive: RETURNING always yields a row; treat a missing one as denied.
  const count = row?.count ?? Number.MAX_SAFE_INTEGER;
  return { allowed: count <= max, remaining: Math.max(0, max - count) };
}

/**
 * Retention bound for stale counter rows: two days comfortably exceeds the
 * largest window in use (the 24h caps in auth.ts / main.ts), so the sweep
 * can never delete a row a live window still needs.
 */
const SWEEP_RETENTION_SECONDS = 172_800;

/**
 * Purge counter rows whose window ended long ago. Runs from the cron tick,
 * off the request hot path: rate-limit keys embed raw client IPs, and the
 * privacy policy promises they are swept on a schedule rather than kept as
 * a durable access log. Best-effort — a failed sweep only delays deletion
 * until the next tick.
 */
export async function sweepRateLimits(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - SWEEP_RETENTION_SECONDS;
  try {
    await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`)
      .bind(cutoff)
      .run();
  } catch (err) {
    console.error("rate_limits sweep failed:", err);
  }
}

/**
 * Fail-closed convenience wrapper for abuse-sensitive endpoints (P4 auth /
 * claim): a D1 error denies the request instead of letting it through
 * unmetered. Same policy as the P3 npub mirror budget.
 */
export async function rateLimitAllows(
  env: Env,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    return (await checkRateLimit(env, key, max, windowSeconds)).allowed;
  } catch (err) {
    console.error(`rate limit check failed for ${key}:`, err);
    return false;
  }
}
