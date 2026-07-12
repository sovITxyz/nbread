# Nostrbook operations (P7)

Hardening + launch reference: security headers, the full per-endpoint
rate-limit/cache inventory, WAF dashboard settings, free-tier incident notes,
the abuse-blocklist admin, and the deploy-gates runbook. Companion to
`docs/setup.md` (one-time zone/DNS/resource setup).

## 1. Security headers

Applied by `src/middleware/headers.ts`, registered FIRST on the outer app so
every Worker response is stamped — guard 404s (unknown/spoofed hosts), tenant
404s, cache hits, redirects, XML feeds, JSON APIs. Two host classes:

| Class | Applies to | CSP | Extra |
| ----- | ---------- | --- | ----- |
| **Blog** | `<handle>.nostrbook.net` (all paths) AND apex `/npub1…` views | `default-src 'none'; img-src * data:; style-src 'self' 'unsafe-inline'; media-src *` | no XFO (blogs stay embeddable) |
| **Apex** | everything else on `nostrbook.net` (+ unknown-host 404s) | `default-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src * data:; media-src *; connect-src 'self' wss:; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` | `X-Frame-Options: DENY` |

Both classes always send `X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin`.

Notes:

- **Blog pages are JS-free by policy** — no `script-src` at all, so
  `default-src 'none'` blocks every script. Enforced by tests
  (`test/integration/headers.spec.ts` asserts no `<script` in blog markup).
- Blog `style-src` carries `'self'` (the shared `/css/style.css` base
  stylesheet) + `'unsafe-inline'` (the sanitized per-blog theme `<style>`).
- Apex needs: same-origin JS (`login.js`, `editor.js`), the **Turnstile**
  script + iframe (`challenges.cloudflare.com` — the only third-party origin
  in the product), `connect-src 'self' wss:` (login/preview/mirror fetches +
  the editor's client-side relay broadcast to arbitrary user relays), and
  `img-src * data:` / `media-src *` so the editor preview renders posts with
  blog fidelity.
- **Cached responses**: the Cache API stores the body from the miss, but the
  headers middleware re-stamps policy on every pass — hits and misses carry
  identical headers (tested for the blog gen cache and the /discover page
  cache).
- **Static assets** (`public/` → `/css/*`, `/js/*`) are served by the Static
  Assets layer *before* the Worker runs and do not carry these headers. They
  are subresources with correct Content-Types, not documents; CSP/XFO are
  document-level policies.

## 2. Endpoint inventory: rate limits, caches, budget bounds

All limiters are D1 fixed windows (`rate_limits`, single upsert per check —
**zero KV writes**) via `checkRateLimit`/`rateLimitAllows`, and **fail
closed** (a D1 error denies). Denied requests still count. Sessions are
permissionless (anyone with a keypair can mint one), so per-pubkey limits are
abuse bounds, not politeness.

### Apex (nostrbook.net)

| Endpoint | Limiter (key → max/window) | Cache | Per-request cost / bound |
| -------- | -------------------------- | ----- | ------------------------ |
| `GET /` | — | — | pure SSR, no storage I/O (WAF backstop) |
| `GET /healthz` | — | — | trivial JSON |
| `GET /login` | — | — | pure SSR |
| `GET /login/challenge` | `challenge:ip` → 10/15min, `challenge:global` → 500/day | `no-store` | D1 nonce insert + expired sweep |
| `POST /login` | `login:ip` → 10/15min | `no-store` | atomic nonce consume, schnorr verify, 1 KV write (session) on success |
| `POST /logout` | `logout:ip` → 30/15min *(P7)* | — | 1 KV **write** (delete) — was the last unmetered KV-write path |
| `GET /dashboard` | session + `dash:pk` → 60/5min *(P7)* | — | ≤100-row post list per render |
| `GET /dashboard/posts/new`, `GET /dashboard/editor` | session | — | 1–2 row reads |
| `POST /dashboard/claim` | `claim:ip` → 3/h + Turnstile + blocked gate | — | reserved-handle read + upsert |
| `POST /dashboard/settings` | `settings:pk` → 20/5min + blocked gate | — | D1 write; KV gen bump **only when css/about changed** |
| `POST /dashboard/preview` | `preview:pk` → 60/5min + `Content-Length` ≤ 400 KB (required) | `no-store` | renderPost on the request path (authed only, budgeted) |
| `POST /api/mirror` | `mirror:pk` → 30/5min + `Content-Length` ≤ 2 MB (required) + `MAX_POSTS_PER_PUBKEY` 1000 + blocked gate | — | schnorr + render-at-ingest + D1/FTS writes + 1 KV gen bump |
| `GET /discover` | `discover:ip` → 60/min **on cache miss only** | Cache API per clamped page (≤50 keys), TTL 300s, 200s only | miss: joined feed query (≤ ~1k rows at page 50); hit: zero D1/KV |
| `GET /search` | `search:ip` → 30/min (non-empty `q` only) | — | FTS MATCH (sanitized) + join, LIMIT 20 |
| `GET /npub1…` (+ `/rss.xml`, `/atom.xml`, `/:slug`) | `npub:ip` → 60/min *(P7)*; relay mirror sessions additionally: per-pubkey cooldown 300s (Cache API marker) + `npub-mirror:ip` → 30/day + `npub-mirror:global` → 500/day, ≤10 verifications/session | — | ≤100-row post list per view (the P7 limiter closes the unmetered-read gap) |
| `GET /.well-known/nostr.json` | — | `max-age=300` | 1-row indexed read (WAF backstop); blocked/unknown → `{"names":{}}` |
| `GET /admin` | ADMIN_PUBKEY gate (404 otherwise) | — | 1 KV session read + ≤200-row blocked list |
| `POST /admin/block`, `POST /admin/unblock` | gate + `admin:pk` → 30/5min *(P7)* | — | 1 D1 write + 1 KV gen bump |

CSRF (Origin / Sec-Fetch-Site same-origin proof) covers **every** unsafe
method on the apex, `/admin` and `/api` included.

### Blog subdomains (`<handle>.nostrbook.net`)

| Endpoint | Limiter | Cache | Per-request cost |
| -------- | ------- | ----- | ---------------- |
| `GET /`, `/:slug`, `/rss.xml`, `/atom.xml`, `/sitemap.xml`, `/robots.txt` | — | Cache API `https://cache.internal/<host><path>?g=<gen>`, `s-maxage=3600`, 200s only | every request: 1 KV read (gen) + 1-row tenant lookup; misses: ≤100-row reads; render is ingest-time HTML (never renderPost) |
| anything else / non-GET | — | — | rendered 404 |

### Cron (`*/15 * * * *`)

Bounded by the relay list (defaults + per-user `settings.relays`, deduped),
the verified-only `sync.since` watermark, and one gen bump per touched pubkey
per run.

### KV write classes (the scarce resource: 1,000 writes/day)

1. **Session create** — `POST /login` (capped 10/15min/IP; key minting itself
   bounded by the 500/day global challenge cap).
2. **Session delete** — `POST /logout` (capped 30/15min/IP).
3. **Gen bumps** — mirror store (editor + cron + npub sessions, all capped),
   settings change (only on real css/about change), admin block/unblock
   (admin-only, 30/5min).

Nothing else writes KV. P7 added **no new KV write classes** — admin bumps
are ordinary gen bumps.

## 3. WAF setup (Cloudflare dashboard, zone `nostrbook.net`)

Application-level limits above bound *single-source* abuse; the WAF is the
*distributed/volumetric* backstop (and keeps scanner noise off the Worker
entirely — every blocked request saves Worker invocations and D1 writes).
Both rules are free-plan features; configure once after Gate B:

### 3a. Zone rate-limiting rule (Security → WAF → Rate limiting rules)

- **Rule name**: `global-per-ip-throttle`
- **If incoming requests match**: Custom expression
  `(http.host eq "nostrbook.net") or (http.host wildcard "*.nostrbook.net")`
- **With the same characteristics**: IP (free plan default)
- **When rate exceeds**: **300 requests / 10 seconds** (the free plan fixes
  the counting period at 10s; 30 rps/IP is far above any human browsing
  pattern and above the busiest app-level limiter)
- **Then take action**: **Block**
- **For duration**: 10 seconds (free-plan mitigation timeout)

### 3b. Scanner-path block (Security → WAF → Custom rules)

- **Rule name**: `scanner-paths-block`
- **Expression**:

  ```
  (ends_with(http.request.uri.path, ".php"))
  or (starts_with(http.request.uri.path, "/wp-"))
  or (http.request.uri.path contains "/.env")
  ```

- **Action**: **Block**

Known trade-off: a blog post whose d-tag slug ends in `.php` or starts with
`wp-` becomes unreachable at the edge. Acceptable; authors control their
slugs and the editor's slugify never mints such shapes.

## 4. Incident notes: free-tier budget exhaustion

| Budget | Daily quota | Exhaustion symptoms | Response |
| ------ | ----------- | ------------------- | -------- |
| **KV writes** | 1,000 | New logins 500 (session put fails); `POST /api/mirror` / settings saves error after the D1 write (gen bump throws) → blogs serve **stale cached pages** until TTL; admin block can't invalidate caches (block still 404s live traffic — the tenant check precedes the cache) | `wrangler tail` to find the writer; block the offending key via `/admin`; verify the write classes above — anything else writing KV is a bug. Quota resets daily (UTC) |
| **KV reads** | 100,000 | Session resolution fails → authed pages 500; blog-page gen reads are try/caught → blogs **degrade to uncached serving** (D1 load rises but pages stay up) | WAF-tighten the hot path (subdomain hosts or `/dashboard`); consider lowering the zone rate rule threshold temporarily |
| **D1 rows read** | 5,000,000 | Feed/blog/search queries error → 500s on misses (cached pages keep serving); `/search` shows its distinct 503 "temporarily unavailable" page | Identify the hot key/IP via `rate_limits` (`SELECT * FROM rate_limits ORDER BY count DESC LIMIT 20`); WAF-block; cached + rate-limited paths (P6/P7) make this hard to reach without distribution |
| **D1 rows written** | 100,000 | **All limiters fail CLOSED** → 429s on challenge/login/discover-miss/search/npub/mirror; nonce issuance fails → logins stop | This is the deliberate fail-safe posture: the platform read paths (cached blogs, discover hits) keep serving. WAF-block the source; wait for reset |
| **Cache API** | best-effort | All cache layers degrade to uncached (every layer is try/caught) → D1/CPU load rises, correctness unchanged | Watch D1 budgets (above); usually transient |
| **Worker requests** | 100,000/day | Cloudflare serves errors once exceeded | WAF rate rule is the main dial; scanner-path block cuts the noise floor |

Observability is enabled in `wrangler.jsonc`; `wrangler tail` gives live
logs (rate-limit denials log their key via `console.error` on D1 failures
only — denials themselves are silent 4xxs by design).

## 5. Abuse blocklist admin

- **Enable**: `wrangler secret put ADMIN_PUBKEY` — hex pubkey or `npub1…` of
  the ONE admin identity. Unset/empty/malformed ⇒ every `/admin` route 404s
  (fail closed). There is no dashboard link to `/admin`; it is deliberately
  undiscoverable.
- **Use**: sign in at `/login` with the admin key (ordinary NIP-07 session),
  then visit `/admin`. Block/unblock by **handle**, **npub**, or **hex
  pubkey** (npub/hex work for keys that never claimed — pre-emptive blocks
  create the users row blocked, which also refuses any later claim).
- **Effect of a block** (all covered by `test/integration/admin.spec.ts`):
  - blog subdomain 404s immediately (tenant check runs before the cache) and
    the gen bump strands every cached page;
  - apex `/npub1…` views 404;
  - posts drop from `/discover` (cached pages age out ≤300s) and `/search`;
  - **NIP-05 policy (decided)**: the handle is dropped from
    `/.well-known/nostr.json` (`{"names":{}}`, indistinguishable from
    unknown) — the platform stops vouching for the identity the moment the
    block lands;
  - writes refuse: `POST /api/mirror`, `/dashboard/settings`,
    `/dashboard/claim` → 403.
- **Unblock** restores everything (fresh gen bump ⇒ no stale pre-block
  cache).
- Admin actions are CSRF-protected (same-origin proof) and rate-limited
  (`admin:pk` 30/5min). Non-admin sessions and anonymous callers see plain
  404s — no probing signal.

## 6. Deploy-gates runbook

**Do not deploy until the orchestrator executes these gates.** Preconditions
for both gates: CI green (typecheck + vitest + `wrangler deploy --dry-run`)
on the release commit, and `bash scripts/smoke.sh local` green.

### Secrets & bindings checklist (once per account)

```sh
wrangler d1 create nostrbook          # paste database_id into wrangler.jsonc
wrangler kv namespace create KV       # paste id into wrangler.jsonc
wrangler d1 migrations apply nostrbook --remote

wrangler secret put TURNSTILE_SECRET_KEY   # from the Turnstile widget (see below)
wrangler secret put ADMIN_PUBKEY           # OPTIONAL — omit to launch with /admin disabled
```

- Create the Turnstile widget (dashboard → Turnstile) for `nostrbook.net`
  **and add the workers.dev preview hostname** (e.g.
  `nostrbook.<account>.workers.dev`) to the widget's hostnames so Gate A can
  exercise the claim flow. Put the site key in `wrangler.jsonc`
  `vars.TURNSTILE_SITE_KEY`.
- `vars.ENVIRONMENT` stays `"production"` in the committed config (the
  dev-only X-Forwarded-Host override must never ship enabled).

### Gate A — workers.dev preview

The zone `nostrbook.net` must already exist on the account (add it per
`docs/setup.md` §1 — routes can attach while DNS still points elsewhere;
user traffic is unaffected because no DNS records exist yet).

```sh
# Deploy with MAIN_HOST overridden to the preview host so the host guard
# treats workers.dev as the apex (the committed var stays nostrbook.net):
npx wrangler deploy --var MAIN_HOST:nostrbook.<account>.workers.dev

# Smoke vs the preview URL (subdomain checks auto-skip on workers.dev):
bash scripts/smoke.sh https://nostrbook.<account>.workers.dev
```

Gate A passes when: CI is green, preview smoke is green, and a manual
login → claim → publish loop works on the preview (needs a NIP-07 extension;
see the manual-check notes at the bottom of `scripts/smoke.sh`).

### Gate B — nostrbook.net live

1. **DNS** (per `docs/setup.md` §2): apex `A @ 192.0.2.1` **Proxied** +
   wildcard `CNAME * nostrbook.net` **Proxied**. SSL/TLS **Full (strict)**;
   confirm Universal SSL covers `nostrbook.net` + `*.nostrbook.net`.
2. **Deploy the committed config** (restores `MAIN_HOST=nostrbook.net`):

   ```sh
   npx wrangler deploy
   ```

3. Verify both routes (`nostrbook.net/*`, `*.nostrbook.net/*`) appear under
   the zone's Workers Routes page and the cron shows under the Worker's
   Triggers tab.
4. **Smoke vs prod** (includes subdomain + header checks):

   ```sh
   bash scripts/smoke.sh https://nostrbook.net
   ```

5. **Observe the cron**: `npx wrangler tail --format=pretty` across one
   15-minute boundary; confirm a `scheduled` execution logs.
6. **Acceptance**: claim a test blog with a real NIP-07 key (login → claim →
   publish via the editor, or publish a NIP-23 post from any Nostr client
   and wait ≤15 min for the cron) and confirm
   `https://<handle>.nostrbook.net/` renders the relay content, RSS
   validates, and `https://nostrbook.net/.well-known/nostr.json?name=<handle>`
   answers.
7. **WAF**: configure §3 (rate rule + scanner-path block).

Rollback: `wrangler deployments list` + `wrangler rollback` restore the
previous Worker version; DNS records can stay (the guard 404s anything it
does not recognize).
