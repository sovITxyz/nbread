/**
 * Fixed-window rate limiting backed by the D1 `rate_limits` table (NOT KV —
 * free-tier KV write budget is reserved for sessions/nonces/gen bumps).
 * Implemented in P4 (auth + handle claim).
 */
export async function checkRateLimit(
  _env: Env,
  _key: string,
  _max: number,
  _windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  throw new Error("Not implemented until P4 (auth)");
}
