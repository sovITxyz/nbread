/**
 * Scheduled refresh (cron every 15 min): for each claimed user, fetch kinds 0+30023
 * since last run and mirror each — capped at ~5 new-event verifications per
 * user per run (schnorr CPU stays under the free-tier 10ms budget), resuming
 * next tick. Implemented in P3 (ingestion).
 */
export async function runRefresh(
  _env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // TODO(P3): iterate claimed users, fetchEvents from RELAYS, mirrorEvent each.
  console.log("cron refresh: not implemented until P3");
}
