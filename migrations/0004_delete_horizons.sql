-- P5 review fix (reviewer A, medium): persist NIP-09 delete horizons OUTSIDE
-- the replaceable kind-5 slot.
--
-- The events table can hold only one kind-5 row per (pubkey, 5, '') slot
-- (UNIQUE(pubkey, kind, d_tag)), so each new delete REPLACES the previous
-- marker and its a-tags. coveredByDeleteHorizon used to scan those stored
-- kind-5 rows, so after a user deleted post A then post B, A's delete horizon
-- vanished with its overwritten marker — a late-arriving intermediate edit of
-- A (created_at between A's stored version and A's delete) would then store
-- with deleted=0 and publicly resurrect the deleted post. The P5 editor makes
-- serial deletes the normal flow, so this is routine, not theoretical.
--
-- This table keeps, per addressable event (kind:pubkey:d_tag), the MAX
-- created_at of any kind-5 delete that has referenced it via an a-tag. It is
-- upserted by applyDelete and consulted by coveredByDeleteHorizon, so a
-- horizon survives forever regardless of how many later deletes overwrite the
-- single stored marker row.
CREATE TABLE delete_horizons (
  address    TEXT PRIMARY KEY,   -- "kind:pubkey:d_tag" (a-tag address)
  deleted_at INTEGER NOT NULL    -- max created_at of a delete covering it
);
