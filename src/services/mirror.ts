import {
  getDTag,
  pickEventFields,
  verifyEvent,
  type NostrEvent,
} from "../nostr/event";
import { renderPost } from "../markdown";
import { postMeta } from "../markdown/nip23";
import { upsertProfile } from "./profiles";

export type MirrorResult = "stored" | "stale" | "invalid";

const HEX_64 = /^[0-9a-f]{64}$/;

/** Current cache generation for a pubkey ("0" when never bumped). */
export async function getGen(env: Env, pubkey: string): Promise<string> {
  return (await env.KV.get(`gen:${pubkey}`)) ?? "0";
}

/**
 * Bump the KV cache generation for a pubkey. Every stored mirror change
 * (post, profile, delete) invalidates that blog's edge cache by changing the
 * `?g=<gen>` component of its cache keys (src/middleware/cache.ts).
 */
export async function bumpGen(env: Env, pubkey: string): Promise<void> {
  const key = `gen:${pubkey}`;
  const current = Number.parseInt((await env.KV.get(key)) ?? "0", 10);
  const next = Number.isFinite(current) && current >= 0 ? current + 1 : 1;
  await env.KV.put(key, String(next));
}

/** Row subset used for replaceable-slot comparisons. */
type SlotRow = { row_id: number; id: string; created_at: number };

async function currentSlot(
  env: Env,
  pubkey: string,
  kind: number,
  dTag: string,
): Promise<SlotRow | null> {
  const row = await env.DB.prepare(
    `SELECT rowid AS row_id, id, created_at FROM events
     WHERE pubkey = ? AND kind = ? AND d_tag = ?`,
  )
    .bind(pubkey, kind, dTag)
    .first<SlotRow>();
  return row ?? null;
}

/**
 * NIP-01 replaceable ordering: does `incoming` lose against the currently
 * stored event for the same (pubkey, kind, d_tag)? Greater created_at wins;
 * ties break to the lexicographically LOWER id (equal id means it IS the
 * stored event, which the id short-circuit already handled).
 */
function losesToCurrent(current: SlotRow, incoming: NostrEvent): boolean {
  if (current.created_at !== incoming.created_at) {
    return current.created_at > incoming.created_at;
  }
  return current.id <= incoming.id;
}

/**
 * Mirror a Nostr event into D1.
 *
 * Contract (docs/phases/CONTRACTS.md): verify → replaceable upsert per
 * (pubkey, kind, d_tag), newest created_at wins, ties broken by lower id →
 * kind 5 delete handling (same-pubkey references only) → render-at-ingest
 * for kind 30023 (events.rendered) → posts_fts maintenance (rowid =
 * events.rowid) → KV gen bump. Verification is skipped for event ids that
 * are already stored (the id is the sha256 of the content, so an id match
 * with the previously verified row means identical content).
 */
export async function mirrorEvent(
  env: Env,
  ev: NostrEvent,
): Promise<MirrorResult> {
  // Already mirrored? The stored row was verified when it was stored; a
  // matching id means byte-identical content, so skip crypto entirely when
  // the sig also matches. A different sig on the same id is unusual (schnorr
  // sigs are not unique) — verify it, then keep the existing row either way.
  const prior = await env.DB.prepare("SELECT sig FROM events WHERE id = ?")
    .bind(ev.id)
    .first<{ sig: string }>();
  if (prior) {
    if (prior.sig === ev.sig) return "stored";
    return (await verifyEvent(ev)) ? "stored" : "invalid";
  }

  if (!(await verifyEvent(ev))) return "invalid";

  if (ev.kind === 5) return applyDelete(env, ev);

  const dTag = getDTag(ev);
  const current = await currentSlot(env, ev.pubkey, ev.kind, dTag);
  if (current && losesToCurrent(current, ev)) return "stale";

  // Render-at-ingest (contract addendum): renderPost+sanitize exactly once,
  // here; the request path serves the stored HTML.
  const rendered = ev.kind === 30023 ? renderPost(ev.content) : null;

  const stmts: D1PreparedStatement[] = [];
  if (current) {
    // Replace: drop the losing row AND its FTS row (rowid-coupled).
    stmts.push(
      env.DB.prepare("DELETE FROM posts_fts WHERE rowid = ?").bind(
        current.row_id,
      ),
      env.DB.prepare("DELETE FROM events WHERE rowid = ?").bind(
        current.row_id,
      ),
    );
  }
  stmts.push(
    env.DB.prepare(
      `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).bind(
      ev.id,
      ev.pubkey,
      ev.kind,
      dTag,
      ev.created_at,
      ev.content,
      JSON.stringify(ev.tags),
      ev.sig,
      JSON.stringify(pickEventFields(ev)),
      rendered,
    ),
  );
  if (ev.kind === 30023) {
    // FTS row with rowid = events.rowid, resolved inside the same atomic
    // batch via INSERT...SELECT (the rowid does not exist before the insert).
    const meta = postMeta(ev);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO posts_fts (rowid, title, summary, content)
         SELECT rowid, ?, ?, ? FROM events WHERE id = ?`,
      ).bind(meta.title, meta.summary ?? "", ev.content, ev.id),
    );
  }
  await env.DB.batch(stmts); // D1 batch runs as a single transaction

  if (ev.kind === 0) await upsertProfile(env, ev);
  await bumpGen(env, ev.pubkey);
  return "stored";
}

/**
 * Kind 5 (NIP-09) delete handling. Marks referenced events `deleted = 1`
 * ONLY when they belong to the deleting pubkey:
 *   - `e` tags: by exact event id (must still be owned by ev.pubkey);
 *   - `a` tags: `kind:pubkey:d_tag` addresses whose embedded pubkey equals
 *     ev.pubkey, limited to versions with created_at <= the delete's
 *     created_at (NIP-09: a later republish supersedes the delete).
 * FTS rows of hidden posts are removed. The kind 5 event itself is stored in
 * its (pubkey, 5, d_tag) slot when it is the newest there — but its side
 * effects apply regardless (deletions are not replaceable; an older second
 * delete must still hide its own targets).
 */
async function applyDelete(env: Env, ev: NostrEvent): Promise<MirrorResult> {
  const eIds: string[] = [];
  const addrs: { kind: number; dTag: string }[] = [];
  for (const tag of ev.tags) {
    if (tag[0] === "e" && typeof tag[1] === "string" && HEX_64.test(tag[1])) {
      eIds.push(tag[1]);
    } else if (tag[0] === "a" && typeof tag[1] === "string") {
      const m = /^(\d{1,5}):([0-9a-f]{64}):([\s\S]*)$/.exec(tag[1]);
      if (m && m[2] === ev.pubkey) {
        addrs.push({ kind: Number(m[1]), dTag: m[3] ?? "" });
      }
    }
  }

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < eIds.length; i += 50) {
    const chunk = eIds.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(", ");
    stmts.push(
      env.DB.prepare(
        `UPDATE events SET deleted = 1
         WHERE pubkey = ? AND kind != 5 AND id IN (${placeholders})`,
      ).bind(ev.pubkey, ...chunk),
    );
  }
  for (const a of addrs) {
    stmts.push(
      env.DB.prepare(
        `UPDATE events SET deleted = 1
         WHERE pubkey = ? AND kind = ? AND d_tag = ? AND kind != 5
           AND created_at <= ?`,
      ).bind(ev.pubkey, a.kind, a.dTag, ev.created_at),
    );
  }
  // Hidden posts leave the search index.
  stmts.push(
    env.DB.prepare(
      `DELETE FROM posts_fts WHERE rowid IN
         (SELECT rowid FROM events WHERE pubkey = ? AND deleted = 1)`,
    ).bind(ev.pubkey),
  );

  // Store the delete marker itself when it is the newest in its slot (the
  // UNIQUE(pubkey, kind, d_tag) schema allows only one row per slot).
  const dTag = getDTag(ev);
  const current = await currentSlot(env, ev.pubkey, 5, dTag);
  if (!current || !losesToCurrent(current, ev)) {
    if (current) {
      stmts.push(
        env.DB.prepare("DELETE FROM events WHERE rowid = ?").bind(
          current.row_id,
        ),
      );
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO events (id, pubkey, kind, d_tag, created_at, content, tags, sig, raw, deleted, rendered)
         VALUES (?, ?, 5, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      ).bind(
        ev.id,
        ev.pubkey,
        dTag,
        ev.created_at,
        ev.content,
        JSON.stringify(ev.tags),
        ev.sig,
        JSON.stringify(pickEventFields(ev)),
      ),
    );
  }

  await env.DB.batch(stmts);
  await bumpGen(env, ev.pubkey);
  return "stored";
}
