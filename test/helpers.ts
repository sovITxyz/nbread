import { env } from "cloudflare:test";
import keys from "./fixtures/keys.json";

export const ALICE_PK = keys.alice.pk;
export const BOB_PK = keys.bob.pk;
export const MALLORY_PK = keys.mallory.pk;

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
