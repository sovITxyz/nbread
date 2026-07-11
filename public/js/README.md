# public/js

Client-side NIP-07 glue:

- `login.js` (P4) — fetches a one-time challenge, signs the kind 22242 auth
  event via `window.nostr`, POSTs it to `/login`. Keys never leave the
  extension.
- `editor.js` (P5, upcoming) — build kind 30023, sign, broadcast to relays,
  POST to `/api/mirror`.
