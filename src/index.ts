import { app } from "./app";
import { runRefresh } from "./cron/refresh";

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await runRefresh(env, ctx);
  },
} satisfies ExportedHandler<Env>;
