/**
 * esbuild entry for public/js/vendor/nostr-crypto.js — the committed
 * client-side crypto vendor bundle (`globalThis.NbreadCrypto`).
 *
 * Built by `npm run build:vendor` (scripts/build-vendor.mjs); the output is
 * committed so deploy never depends on a build step. CI rebuilds and fails on
 * drift.
 *
 * Contents:
 *   - encoding utils (hex / utf-8 / base64 / randomBytes)
 *   - bech32 + npub/nsec codecs (ported verbatim from src/nostr/nip19.ts —
 *     BIP-173 checksum constant 1, NOT bech32m)
 *   - NIP-01 event id + BIP-340 schnorr sign/verify (byte-identical to
 *     src/nostr/event.ts serializeEvent/getEventId)
 *   - NIP-44 v2 encryption (hkdf/hmac/sha256 from @noble/hashes, chacha20
 *     from @noble/ciphers)
 *   - NIP-04 legacy encryption (AES-256-CBC via crypto.subtle, async)
 *
 * SECURITY: all randomness comes from crypto.getRandomValues. Never
 * Math.random, never a Node 'crypto' import (this bundle runs in browsers
 * and workerd only).
 */
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js";
import { chacha20 } from "@noble/ciphers/chacha.js";

// ---------------------------------------------------------------------------
// Encoding utilities
// ---------------------------------------------------------------------------

const HEX_64 = /^[0-9a-f]{64}$/;

/** Decode a lowercase/uppercase hex string to bytes. Throws on malformed input. */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error("NbreadCrypto: invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode bytes as lowercase hex. */
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/** UTF-8 encode a string to bytes. */
function utf8Encode(s) {
  return textEncoder.encode(s);
}

/** UTF-8 decode bytes to a string. */
function utf8Decode(b) {
  return textDecoder.decode(b);
}

/**
 * Standard base64 (RFC 4648, with padding) of raw bytes. btoa is chunked so
 * large payloads never blow the argument/stack limits of String.fromCharCode.
 */
function base64Encode(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Strict RFC 4648 base64 shape: 4-char groups, correct '=' padding at the
 * end only, no whitespace. atob alone implements the WHATWG "forgiving
 * base64" algorithm (skips whitespace, tolerates missing padding), which
 * would make distinct payload strings decode to the same bytes — mirror
 * @scure/base's strict behavior instead so nip44Decrypt matches nostr-tools.
 */
const BASE64_STRICT = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decode standard base64 (strict, canonical padding) to bytes. Throws on malformed input. */
function base64Decode(s) {
  if (typeof s !== "string" || !BASE64_STRICT.test(s)) {
    throw new Error("NbreadCrypto: invalid base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Cryptographically secure random bytes. SECURITY CRITICAL: this is the only
 * RNG in the bundle — crypto.getRandomValues exists in every browser and in
 * workerd; Math.random must never appear here. Filled in 64 KiB chunks
 * because the WebCrypto spec caps getRandomValues at 65536 bytes per call.
 */
function randomBytes(n) {
  const out = new Uint8Array(n);
  const CHUNK = 65536;
  for (let i = 0; i < out.length; i += CHUNK) {
    crypto.getRandomValues(out.subarray(i, i + CHUNK));
  }
  return out;
}

/** Concatenate byte arrays. */
function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** Constant-time byte-array equality (for MAC verification). */
function equalBytesConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// bech32 (BIP-173, checksum constant 1 — NIP-19 does not use bech32m).
// Ported verbatim from src/nostr/nip19.ts; keep the two in sync.
// ---------------------------------------------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const CHARSET_REV = new Map([...CHARSET].map((c, i) => [c, i]));
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
/** NIP-19 entities exceed BIP-173's 90-char cap; cap length like nostr-tools. */
const MAX_BECH32_LENGTH = 5000;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Regroup bits. `pad` is true when encoding (8→5), false when decoding (5→8);
 * decoding rejects nonzero or over-long padding per BIP-173.
 */
function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >>> fromBits !== 0) {
      throw new Error("NbreadCrypto: invalid value in bit conversion");
    }
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error("NbreadCrypto: invalid padding in bech32 data");
  }
  return out;
}

/** Encode raw bytes as a bech32 string under `hrp`. */
function bech32Encode(hrp, bytes) {
  const data = convertBits(bytes, 8, 5, true);
  const combined = [...hrpExpand(hrp), ...data];
  const polymodTarget = polymod([...combined, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) {
    checksum.push((polymodTarget >>> (5 * (5 - i))) & 31);
  }
  const encoded = hrp + "1" + [...data, ...checksum].map((v) => CHARSET[v]).join("");
  if (encoded.length > MAX_BECH32_LENGTH) {
    throw new Error("NbreadCrypto: encoded bech32 entity too long");
  }
  return encoded;
}

/** Decode a bech32 string to `{ hrp, bytes }`. Throws on any corruption. */
function bech32Decode(str) {
  if (typeof str !== "string" || str.length < 8 || str.length > MAX_BECH32_LENGTH) {
    throw new Error("NbreadCrypto: invalid bech32 length");
  }
  const lower = str.toLowerCase();
  if (str !== lower && str !== str.toUpperCase()) {
    throw new Error("NbreadCrypto: mixed-case bech32 is invalid");
  }
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || sep + 7 > lower.length) {
    throw new Error("NbreadCrypto: missing bech32 separator or checksum");
  }
  const hrp = lower.slice(0, sep);
  for (let i = 0; i < hrp.length; i++) {
    const code = hrp.charCodeAt(i);
    if (code < 33 || code > 126) {
      throw new Error("NbreadCrypto: invalid bech32 hrp character");
    }
  }
  const data = [];
  for (const ch of lower.slice(sep + 1)) {
    const v = CHARSET_REV.get(ch);
    if (v === undefined) throw new Error("NbreadCrypto: invalid bech32 character");
    data.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) {
    throw new Error("NbreadCrypto: bad bech32 checksum");
  }
  const bytes = Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false));
  return { hrp, bytes };
}

// ---------------------------------------------------------------------------
// NIP-19 fixed-prefix codecs (npub / nsec)
// ---------------------------------------------------------------------------

function hexToBytes32(hex, what) {
  if (typeof hex !== "string" || !HEX_64.test(hex)) {
    throw new Error(`NbreadCrypto: ${what} must be 64 lowercase hex chars`);
  }
  return hexToBytes(hex);
}

function decode32(str, expectedHrp) {
  const { hrp, bytes } = bech32Decode(str);
  if (hrp !== expectedHrp) {
    throw new Error(`NbreadCrypto: expected ${expectedHrp}, got ${hrp}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`NbreadCrypto: ${expectedHrp} payload must be 32 bytes`);
  }
  return bytesToHex(bytes);
}

/** Encode a 32-byte hex pubkey as `npub1…`. */
function npubEncode(pkHex) {
  return bech32Encode("npub", hexToBytes32(pkHex, "pubkey"));
}

/** Decode an `npub1…` string to 64-char hex. Throws on wrong hrp/corruption. */
function npubDecode(npub) {
  return decode32(npub, "npub");
}

/** Encode a 32-byte hex secret key as `nsec1…`. */
function nsecEncode(skHex) {
  return bech32Encode("nsec", hexToBytes32(skHex, "secret key"));
}

/** Decode an `nsec1…` string to 64-char hex. Throws on wrong hrp/corruption. */
function nsecDecode(nsec) {
  return decode32(nsec, "nsec");
}

// ---------------------------------------------------------------------------
// NIP-01 event id + BIP-340 schnorr
// ---------------------------------------------------------------------------

/**
 * NIP-01 canonical serialization + sha256, as lowercase hex. MUST stay
 * byte-identical to src/nostr/event.ts serializeEvent + getEventId:
 * JSON.stringify escapes exactly the characters NIP-01 mandates.
 */
function eventId(unsigned) {
  const serialized = JSON.stringify([
    0,
    unsigned.pubkey,
    unsigned.created_at,
    unsigned.kind,
    unsigned.tags,
    unsigned.content,
  ]);
  return bytesToHex(sha256(utf8Encode(serialized)));
}

/** x-only BIP-340 public key for a 32-byte secret key, as 64-char hex. */
function getPublicKeyHex(skBytes) {
  return bytesToHex(schnorr.getPublicKey(skBytes));
}

/** BIP-340 schnorr signature over a 32-byte hex message, as 128-char hex. */
function schnorrSign(msgHex, skBytes) {
  return bytesToHex(schnorr.sign(hexToBytes(msgHex), skBytes));
}

/** Verify a BIP-340 schnorr signature. Never throws — malformed input is false. */
function schnorrVerify(sigHex, msgHex, pubHex) {
  try {
    return schnorr.verify(hexToBytes(sigHex), hexToBytes(msgHex), hexToBytes(pubHex));
  } catch {
    return false;
  }
}

/**
 * Derive the pubkey, compute the NIP-01 id, and schnorr-sign it.
 * `unsignedNoPubkey` carries {kind, created_at, tags, content}.
 */
function finalizeEvent(unsignedNoPubkey, skBytes) {
  const pubkey = getPublicKeyHex(skBytes);
  const unsigned = {
    pubkey,
    created_at: unsignedNoPubkey.created_at,
    kind: unsignedNoPubkey.kind,
    tags: unsignedNoPubkey.tags,
    content: unsignedNoPubkey.content,
  };
  const id = eventId(unsigned);
  const sig = schnorrSign(id, skBytes);
  return {
    id,
    pubkey,
    kind: unsigned.kind,
    created_at: unsigned.created_at,
    tags: unsigned.tags,
    content: unsigned.content,
    sig,
  };
}

// ---------------------------------------------------------------------------
// ECDH shared x-coordinate (used by both NIP-44 and NIP-04)
// ---------------------------------------------------------------------------

/**
 * secp256k1 ECDH: x-coordinate (32 bytes) of the shared point between our
 * secret key and the peer's x-only pubkey (lifted with even-y prefix 0x02).
 */
function sharedX(skBytes, pubHex) {
  const pub = hexToBytes32(pubHex, "pubkey");
  const shared = secp256k1.getSharedSecret(skBytes, concatBytes(new Uint8Array([2]), pub));
  return shared.subarray(1, 33);
}

// ---------------------------------------------------------------------------
// NIP-44 v2
// ---------------------------------------------------------------------------

const NIP44_SALT = utf8Encode("nip44-v2");
const NIP44_MIN_PLAINTEXT = 1;
const NIP44_MAX_PLAINTEXT = 65535;

/** Conversation key: hkdf-extract(sha256, ikm = ECDH x, salt = "nip44-v2"). */
function nip44ConversationKey(skBytes, pubHex) {
  return hkdfExtract(sha256, sharedX(skBytes, pubHex), NIP44_SALT);
}

/** Per-message keys: hkdf-expand(convKey, nonce, 76) → chacha key/nonce + hmac key. */
function nip44MessageKeys(convKey, nonce) {
  if (convKey.length !== 32) {
    throw new Error("NbreadCrypto: nip44 conversation key must be 32 bytes");
  }
  if (nonce.length !== 32) {
    throw new Error("NbreadCrypto: nip44 nonce must be 32 bytes");
  }
  const keys = hkdfExpand(sha256, convKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

/**
 * NIP-44 padded length: min 32, then power-of-two buckets (chunk 32 up to
 * 256, nextPower/8 beyond). Matches the spec's calc_padded_len exactly.
 */
function nip44CalcPaddedLen(len) {
  if (!Number.isSafeInteger(len) || len < 1) {
    throw new Error("NbreadCrypto: expected positive integer");
  }
  if (len <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(len - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((len - 1) / chunk) + 1);
}

/** Pad: u16be(len) || plaintext || zeros, to calc_padded_len(len). */
function nip44Pad(plaintext) {
  const unpadded = utf8Encode(plaintext);
  const len = unpadded.length;
  if (len < NIP44_MIN_PLAINTEXT || len > NIP44_MAX_PLAINTEXT) {
    throw new Error(
      "NbreadCrypto: invalid nip44 plaintext size: must be 1..65535 bytes",
    );
  }
  const prefix = new Uint8Array([(len >>> 8) & 0xff, len & 0xff]);
  const suffix = new Uint8Array(nip44CalcPaddedLen(len) - len);
  return concatBytes(prefix, unpadded, suffix);
}

/** Unpad and UTF-8 decode. Throws on any inconsistency. */
function nip44Unpad(padded) {
  if (padded.length < 34) throw new Error("NbreadCrypto: invalid nip44 padding");
  const len = (padded[0] << 8) | padded[1];
  if (
    len < NIP44_MIN_PLAINTEXT ||
    len > NIP44_MAX_PLAINTEXT ||
    padded.length !== 2 + nip44CalcPaddedLen(len)
  ) {
    throw new Error("NbreadCrypto: invalid nip44 padding");
  }
  return utf8Decode(padded.subarray(2, 2 + len));
}

/**
 * INTERNAL fixed-nonce NIP-44 v2 encrypt. Exposed on the API only under the
 * explicitly unsafe name `__nip44EncryptWithNonceForTests` so unit tests can
 * validate against the official fixed-nonce vectors. Reusing a nonce reuses
 * the ChaCha20 keystream and HMAC key — NEVER call this from production code;
 * use nip44Encrypt, which always draws a fresh CSPRNG nonce.
 */
function nip44EncryptWithNonce(convKey, plaintext, nonce) {
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(convKey, nonce);
  const padded = nip44Pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  return base64Encode(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}

/**
 * NIP-44 v2 encrypt: payload = base64(0x02 || nonce(32) || chacha20(padded) ||
 * hmac-sha256(hmacKey, nonce || ciphertext)). The nonce is ALWAYS fresh
 * CSPRNG bytes — callers cannot supply one (no nonce-reuse footgun).
 */
function nip44Encrypt(convKey, plaintext) {
  return nip44EncryptWithNonce(convKey, plaintext, randomBytes(32));
}

/**
 * NIP-44 v2 decrypt. Verifies version == 2 and the MAC (constant-time)
 * BEFORE decrypting. Throws on any tampering or malformed payload.
 */
function nip44Decrypt(convKey, payload) {
  if (typeof payload !== "string" || payload.length === 0) {
    throw new Error("NbreadCrypto: invalid nip44 payload");
  }
  if (payload[0] === "#") {
    throw new Error("NbreadCrypto: unknown nip44 encryption version");
  }
  // Spec decode_payload bounds: base64 string 132..87472 chars.
  if (payload.length < 132 || payload.length > 87472) {
    throw new Error("NbreadCrypto: invalid nip44 payload length");
  }
  const data = base64Decode(payload);
  // Spec decode_payload bounds: decoded data 99..65603 bytes. Minimum is
  // version(1) + nonce(32) + ciphertext(2 + 32 padded) + mac(32).
  if (data.length < 99 || data.length > 65603) {
    throw new Error("NbreadCrypto: invalid nip44 data length");
  }
  if (data[0] !== 2) {
    throw new Error(`NbreadCrypto: unknown nip44 encryption version ${data[0]}`);
  }
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(convKey, nonce);
  const expectedMac = hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
  if (!equalBytesConstantTime(mac, expectedMac)) {
    throw new Error("NbreadCrypto: invalid nip44 MAC");
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return nip44Unpad(padded);
}

// ---------------------------------------------------------------------------
// NIP-04 (legacy; decrypt fallback for old DMs / NIP-46 responses)
// ---------------------------------------------------------------------------

/** Import the raw ECDH x-coordinate as an AES-256-CBC WebCrypto key. */
async function nip04Key(skBytes, pubHex, usage) {
  return crypto.subtle.importKey("raw", sharedX(skBytes, pubHex), { name: "AES-CBC" }, false, [
    usage,
  ]);
}

/** NIP-04 encrypt: AES-256-CBC, payload "<base64ct>?iv=<base64iv>". */
async function nip04Encrypt(skBytes, pubHex, text) {
  const key = await nip04Key(skBytes, pubHex, "encrypt");
  const iv = randomBytes(16);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, utf8Encode(text)),
  );
  return `${base64Encode(ciphertext)}?iv=${base64Encode(iv)}`;
}

/** NIP-04 decrypt of a "<base64ct>?iv=<base64iv>" payload. */
async function nip04Decrypt(skBytes, pubHex, payload) {
  if (typeof payload !== "string") {
    throw new Error("NbreadCrypto: invalid nip04 payload");
  }
  const sep = payload.indexOf("?iv=");
  if (sep === -1) throw new Error("NbreadCrypto: invalid nip04 payload");
  const ciphertext = base64Decode(payload.slice(0, sep));
  const iv = base64Decode(payload.slice(sep + 4));
  if (iv.length !== 16) throw new Error("NbreadCrypto: invalid nip04 iv");
  const key = await nip04Key(skBytes, pubHex, "decrypt");
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv }, key, ciphertext),
  );
  return utf8Decode(plaintext);
}

// ---------------------------------------------------------------------------
// Public API — frozen; other client modules code against exactly this shape.
// ---------------------------------------------------------------------------

const api = {
  // encoding
  hexToBytes,
  bytesToHex,
  utf8Encode,
  utf8Decode,
  base64Encode,
  base64Decode,
  randomBytes,
  // bech32 / NIP-19
  bech32Encode,
  bech32Decode,
  npubEncode,
  npubDecode,
  nsecEncode,
  nsecDecode,
  // NIP-01 / BIP-340
  eventId,
  getPublicKeyHex,
  schnorrSign,
  schnorrVerify,
  finalizeEvent,
  // NIP-44 v2
  nip44ConversationKey,
  nip44Encrypt,
  nip44Decrypt,
  // UNSAFE, tests only: fixed-nonce encrypt for the official NIP-44 vectors.
  __nip44EncryptWithNonceForTests: nip44EncryptWithNonce,
  // NIP-04 (legacy)
  nip04Encrypt,
  nip04Decrypt,
};

Object.freeze(api);

// Explicit global assignment — the ONLY export surface. This works both as a
// classic <script> include and when imported for its side effect (vitest unit
// tests), so tests exercise the exact object browsers receive. Deliberately
// no ESM `export` list and no esbuild `globalName`: a second export surface
// would have to be kept in lockstep with `api` by hand, and drift between the
// two shapes would be invisible to CI.
globalThis.NbreadCrypto = api;
