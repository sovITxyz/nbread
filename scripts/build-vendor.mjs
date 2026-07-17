/**
 * Build the committed client crypto vendor bundle:
 *   scripts/vendor/crypto-entry.js  →  public/js/vendor/nostr-crypto.js
 *
 * Run via `npm run build:vendor`. The output is a plain IIFE (globalThis.
 * NbreadCrypto), unminified for auditability, and COMMITTED — deploy never
 * runs this. CI rebuilds and requires `git status --porcelain
 * public/js/vendor/` to be empty (tracked drift AND new untracked output), so
 * any mismatch between entry/deps and the committed artifact fails the build.
 *
 * Determinism: esbuild output is a pure function of the entry file, the
 * pinned dependency versions (package-lock.json), and the pinned esbuild
 * version. Paths in the bundle's comments are relative to the repo root
 * (we chdir there), so the output is machine-independent.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { statSync } from "node:fs";
import { build } from "esbuild";

// Always build relative to the repo root regardless of invocation cwd.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const OUTFILE = "public/js/vendor/nostr-crypto.js";

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Built from scripts/vendor/crypto-entry.js by \`npm run build:vendor\`
 * (scripts/build-vendor.mjs). Bundles @noble/curves, @noble/hashes, and
 * @noble/ciphers (devDependencies pinned in package-lock.json) into a plain
 * IIFE exposing globalThis.NbreadCrypto. Committed unminified so the served
 * asset is auditable; CI rebuilds and fails on drift.
 */`;

await build({
  entryPoints: ["scripts/vendor/crypto-entry.js"],
  outfile: OUTFILE,
  bundle: true,
  // Plain IIFE with NO `globalName`: the entry's explicit
  // `globalThis.NbreadCrypto = api` assignment is the single export surface,
  // so classic <script> consumers and vitest (side-effect import) see the
  // exact same frozen object.
  format: "iife",
  platform: "browser",
  target: "es2020",
  minify: false,
  treeShaking: true,
  charset: "utf8",
  legalComments: "inline",
  banner: { js: BANNER },
  logLevel: "info",
});

const bytes = statSync(OUTFILE).size;
console.log(`build:vendor → ${OUTFILE} (${bytes} bytes)`);
