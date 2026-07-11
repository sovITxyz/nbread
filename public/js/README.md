# public/js

Client-side NIP-07 glue lands here in later phases:

- `login.js` (P4) — build + sign the kind 22242 auth event via `window.nostr`.
- `editor.js` (P5) — build kind 30023, sign, broadcast to relays, POST to `/api/mirror`.
