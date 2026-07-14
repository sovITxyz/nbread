import { app } from "./app";
import { runRefresh } from "./cron/refresh";
import { sweepRateLimits } from "./services/ratelimit";

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runRefresh(env, ctx);
    // IP-keyed counter rows are retention-bounded (see privacy policy).
    await sweepRateLimits(env);
  },
} satisfies ExportedHandler<Env>;
