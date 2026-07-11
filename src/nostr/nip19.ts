/** NIP-19 bech32 codecs. Implemented in P1 (nostr core). */

export type AddressPointer = {
  identifier: string; // d tag
  pubkey: string;
  kind: number;
  relays?: string[];
};

export function npubEncode(_pubkeyHex: string): string {
  throw new Error("Not implemented until P1 (nostr core)");
}

export function npubDecode(_npub: string): string {
  throw new Error("Not implemented until P1 (nostr core)");
}

export function naddrEncode(_ptr: AddressPointer): string {
  throw new Error("Not implemented until P1 (nostr core)");
}

export function naddrDecode(_naddr: string): AddressPointer {
  throw new Error("Not implemented until P1 (nostr core)");
}
