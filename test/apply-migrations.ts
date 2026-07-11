// Vitest setup file: apply D1 migrations before each test file runs.
// TEST_MIGRATIONS is injected by vitest.config.ts via readD1Migrations().
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
