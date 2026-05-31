-- Run this BEFORE `pnpm db:push` if you may have duplicate
-- (codelet_id, user_id) rows in codelet_member. Without this, adding
-- the composite primary key will fail with a unique constraint error.
--
-- Keeps the oldest row per pair (smallest joined_at) and deletes the rest.

DELETE FROM codelet_member dm
USING codelet_member dup
WHERE dm.codelet_id = dup.codelet_id
  AND dm.user_id    = dup.user_id
  AND dm.ctid       <> dup.ctid
  AND (dm.joined_at, dm.ctid) > (dup.joined_at, dup.ctid);
