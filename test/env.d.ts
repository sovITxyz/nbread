// Test-only env augmentation. `env` from "cloudflare:test" is typed as
// Cloudflare.Env; TEST_MIGRATIONS is injected by vitest.config.ts via
// readD1Migrations(). This file must stay a global script (no top-level
// imports) so the namespace merges with worker-configuration.d.ts.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
