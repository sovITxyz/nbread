// Fixture validity self-check: every committed "valid" fixture must verify,
// every tampered variant must fail, and the replaceable pair must be ordered.
import { describe, expect, it } from "vitest";
import { verifyEvent, type Event as NostrEvent } from "nostr-tools/pure";
import fixtures from "../fixtures/events.json";
import keys from "../fixtures/keys.json";

// Fixtures come from JSON so they carry no nostr-tools verification cache.
const profiles = Object.values(fixtures.profiles) as NostrEvent[];
const posts = Object.values(fixtures.posts) as NostrEvent[];
const replaceable = fixtures.replaceable as {
  stale: NostrEvent;
  newer: NostrEvent;
};
const deleteEvent = fixtures.delete as NostrEvent;
const tampered = fixtures.tampered as { reason: string; event: NostrEvent }[];

describe("fixture validity", () => {
  it("all valid events verify (profiles, posts, replaceable pair, delete)", () => {
    const all = [
      ...profiles,
      ...posts,
      replaceable.stale,
      replaceable.newer,
      deleteEvent,
    ];
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const ev of all) {
      expect(verifyEvent(ev), `event ${ev.id} should verify`).toBe(true);
    }
  });

  it("every tampered variant fails verification", () => {
    const reasons = tampered.map((t) => t.reason).sort();
    expect(reasons).toEqual(["bad_id", "bad_sig", "wrong_pubkey"]);
    for (const t of tampered) {
      expect(verifyEvent(t.event), `tampered (${t.reason}) must fail`).toBe(
        false,
      );
    }
  });

  it("posts are kind 30023 with d tags; profiles are kind 0", () => {
    for (const p of posts) {
      expect(p.kind).toBe(30023);
      expect(p.tags.some(([k, v]) => k === "d" && !!v)).toBe(true);
    }
    for (const p of profiles) {
      expect(p.kind).toBe(0);
    }
  });

  it("replaceable pair shares pubkey/kind/d-tag and newer wins on created_at", () => {
    const dTag = (ev: NostrEvent) =>
      ev.tags.find(([k]) => k === "d")?.[1] ?? "";
    expect(replaceable.stale.pubkey).toBe(replaceable.newer.pubkey);
    expect(replaceable.stale.kind).toBe(replaceable.newer.kind);
    expect(dTag(replaceable.stale)).toBe(dTag(replaceable.newer));
    expect(replaceable.newer.created_at).toBeGreaterThan(
      replaceable.stale.created_at,
    );
  });

  it("delete event is kind 5 and references alice's post", () => {
    expect(deleteEvent.kind).toBe(5);
    expect(deleteEvent.pubkey).toBe(keys.alice.pk);
    const eTags = deleteEvent.tags.filter(([k]) => k === "e");
    expect(eTags.length).toBeGreaterThan(0);
  });

  it("fixture keys are the labeled throwaway patterns", () => {
    expect(keys.WARNING).toContain("THROWAWAY");
    expect(keys.alice.sk).toBe("01".repeat(32));
    expect(keys.bob.sk).toBe("02".repeat(32));
    expect(keys.mallory.sk).toBe("03".repeat(32));
  });
});
