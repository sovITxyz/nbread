/** A Nostr event (NIP-01). Stable contract type — do not change without orchestrator approval. */
export type NostrEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

/**
 * Verify a Nostr event: recompute the canonical-serialization sha256 id and
 * schnorr-verify the signature (@noble/curves, @noble/hashes).
 * Implemented in P1 (Nostr core).
 */
export async function verifyEvent(_ev: NostrEvent): Promise<boolean> {
  throw new Error("Not implemented until P1 (nostr core)");
}
