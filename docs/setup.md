# nbread.lol — zone / DNS / infrastructure setup checklist

Manual, one-time steps done in the Cloudflare dashboard + wrangler CLI. Nothing
here is needed for local dev or CI; local D1/KV are simulated.

## 1. Zone

- [ ] Add the `nbread.lol` zone to the Cloudflare account (free plan).
- [ ] Point the registrar's nameservers at the two Cloudflare-assigned NS hosts.
- [ ] Wait for the zone to become **Active**.
- [ ] SSL/TLS mode: **Full (strict)**.
- [ ] Edge Certificates: confirm the Universal SSL cert covers `nbread.lol`
      and `*.nbread.lol` (universal certs include the first-level wildcard).
- [ ] Edge Certificates (at Gate B, once TLS is confirmed working): enable
      **Always Use HTTPS** + **HSTS** (`max-age` ≥ 6 months; hold
      `includeSubDomains`/preload until tenant subdomains are confirmed stable
      on TLS — see `docs/ops.md` §6 Gate B step 1).

## 2. DNS records

| Type  | Name | Content                  | Proxy   |
| ----- | ---- | ------------------------ | ------- |
| A     | `@`  | `192.0.2.1` (dummy)      | Proxied |
| CNAME | `*`  | `nbread.lol`          | Proxied |

- The apex A record is a placeholder — the Worker route intercepts all traffic;
  any proxied record works (or use a Workers **custom domain** on the apex
  instead, which manages the record automatically).
- The wildcard CNAME must be **proxied** (orange cloud) or subdomains bypass
  the Worker. Free plans proxy first-level wildcards fine.
- [ ] Optional: `_dmarc` TXT + SPF once outbound mail is a thing (not yet).

## 3. Worker resources (once per account)

```sh
wrangler d1 create nbread          # → paste database_id into wrangler.jsonc
wrangler d1 migrations apply nbread --remote
wrangler kv namespace create KV       # → paste id into wrangler.jsonc
wrangler secret put TURNSTILE_SECRET_KEY
wrangler secret put ADMIN_PUBKEY      # OPTIONAL: hex/npub admin identity for /admin
                                      # (omit → admin surface disabled, all /admin 404)
```

- [ ] Create a Turnstile widget (dashboard → Turnstile) for `nbread.lol`
      **plus the workers.dev preview hostname** (Gate A tests the claim flow
      there); put the site key in `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY`
      and the secret via `wrangler secret put`.
- `vars.ENVIRONMENT` is already `"production"` in the committed
  `wrangler.jsonc` (fail closed — deploys never enable the dev-only
  X-Forwarded-Host override). Local dev gets `ENVIRONMENT=development` from
  `.dev.vars` (copy `.dev.vars.example`); do not flip the committed var.

## 4. Routes + cron (deployed from wrangler.jsonc)

`wrangler deploy` registers:

- routes `nbread.lol/*` and `*.nbread.lol/*` (zone `nbread.lol`)
- cron trigger `*/15 * * * *`

- [ ] After first deploy, verify both routes appear under the zone's
      Workers Routes page and the cron shows in the Worker's Triggers tab.
- [ ] Tail logs (`wrangler tail`) across one 15-minute boundary to observe a
      cron execution.

## 5. Launch gates (P7 runbook — full detail in `docs/ops.md` §6)

- Gate A: `wrangler deploy --var MAIN_HOST:nbread.<account>.workers.dev`
  to the `workers.dev` preview URL; CI green +
  `bash scripts/smoke.sh https://nbread.<account>.workers.dev` green
  (subdomain checks auto-skip on workers.dev).
- Gate B: flip DNS (section 2), `wrangler deploy` (committed vars), re-run
  smoke against `https://nbread.lol`, confirm cron observed in
  `wrangler tail`, and verify a claimed test blog renders real relay content.
- Post-launch: configure the WAF rate rule + scanner-path block
  (`docs/ops.md` §3) and set `ADMIN_PUBKEY` if the blocklist admin is wanted
  (`docs/ops.md` §5).

## 6. Deployment record — LIVE (2026-07-14)

The project moved from `nostrbook.net` to **`nbread.lol`** with **fresh resources**
on the account that owns the `nbread.lol` zone. The old `nostrbook.net` D1/KV live
on a different account (**Sovereign IT** `2d2cca…`) and were **not reused** (worker
routes must bind a zone on the same account); the ~1-day-old data did not carry
over — reserved handles were re-seeded and posts re-mirror from relays.

Account **`830ade508fd3f90a2a591477cdbd399c`** (Kinseycagney), zone `nbread.lol`
(`af6ac54c001d8d5c0ae21b81ab2b91e4`). Pinned as `account_id` in `wrangler.jsonc`.

- **D1** `nbread` `8308f106-5d7f-443d-b34c-e8cb16728bd2` (region ENAM); all 4
  migrations applied `--remote`; 11 reserved handles seeded.
- **KV** `d01e2e69d35549bb8ee153ac4007dbe2` (binding `KV`).
- **Turnstile** widget "nbread.lol" (Managed), site key
  `0x4AAAAAAD1_vRxPvgk56oO-`, domain `nbread.lol`. `TURNSTILE_SECRET_KEY` set via
  `wrangler secret put`. (`ADMIN_PUBKEY` unset ⇒ `/admin` 404s — optional.)
- **DNS** (proxied): apex `A @ 192.0.2.1`, apex `AAAA @ 100::`, wildcard
  `CNAME * → nbread.lol`. `www` left on the registrar CNAME (`pixie.porkbun.com`)
  — follow-up: repoint or add a `www → apex` redirect.
- **SSL/TLS**: Full (strict); Universal SSL active covering `nbread.lol` +
  `*.nbread.lol`; Always Use HTTPS **on**; HSTS `max-age=15552000` (no
  `includeSubDomains`/preload); TLS 1.3 **on**.
- **Worker `nbread`**: deployed with routes `nbread.lol/*` + `*.nbread.lol/*`
  and cron `*/15 * * * *`. `workers_dev` is **false** (production serves via the
  zone routes); the account's workers.dev subdomain is `nbread` (created to
  unblock the cron schedules API — flip `workers_dev` to true to also publish to
  `nbread.nbread.workers.dev`).
- **WAF**: `global-per-ip-throttle` (60 req/10s per IP+colo, block 10s, host
  `nbread.lol` + `*.nbread.lol`) + `scanner-paths-block` (`.php`, `/wp-`, `/.env`
  → block).
- **Smoke**: `bash scripts/smoke.sh https://nbread.lol` → 54/54 green.

### Outstanding (optional)

- **`ADMIN_PUBKEY`** unset — set via `wrangler secret put` to enable the `/admin`
  blocklist surface (unset ⇒ all `/admin` 404, which smoke asserts).
- **`www.nbread.lol`** still CNAMEs to the registrar parking host — repoint or
  add a `www → apex` redirect if wanted.

The old `nostrbook` worker / `nostrbook.net` zone keep serving until explicitly
retired — decommission is a separate step.
