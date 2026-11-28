// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
export async function getState(db) {
  const collections = (await db.prepare("SELECT * FROM collections ORDER BY sort_order").all()).results;
  // Links whose collection no longer exists are never handed back (a link saved on one
  // computer after its collection was deleted on another would otherwise float around).
  const links = (await db.prepare(
    "SELECT * FROM links WHERE collection_id IN (SELECT id FROM collections) ORDER BY collection_id, sort_order"
  ).all()).results;
  return { collections, links };
}

function validUrl(u) {
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:"; }
  catch { return false; }
}

const STR = (v, max = 2000) => typeof v === "string" && v.length <= max;
const ID = (v) => typeof v === "string" && v.length >= 1 && v.length <= 64;
// Timestamps are what Date.prototype.toISOString() writes. They're compared as text for
// last-write-wins, so any other shape is refused.
const TS = (v) => {
  if (typeof v !== "string" || v.length !== 24) return false;
  const t = Date.parse(v);
  return !Number.isNaN(t) && new Date(t).toISOString() === v; // a real date, always 3 ms digits
};
const NUM = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// How long a counted click's id is remembered. A retry comes from the same queue entry,
// which stays until the Worker answers, so this only has to outlast a long time offline.
const CLICK_ID_DAYS = 90;

export async function applyOps(db, ops) {
  let applied = 0, skipped = 0;
  if (ops.some((o) => o?.type === "click" && o.op_id !== undefined)) {
    const cutoff = new Date(Date.now() - CLICK_ID_DAYS * 864e5).toISOString();
    await db.prepare("DELETE FROM click_ops WHERE seen_at < ?1").bind(cutoff).run();
  }
  for (const op of ops) {
    // An op the rules refuse (bad shape, stale) is skipped. A database error is different:
    // it throws, the request fails, and the sender keeps its queue and tries again later.
    // Answering "ok" here would make the sender drop changes that were never stored.
    let ok;
    try { ok = await applyOne(db, op); }
    catch (err) {
      // A constraint the rules above didn't foresee is still a "no" for this one op.
      // Retrying it would fail the same way forever and block everything queued behind it.
      if (!/constraint/i.test(String(err?.message || err))) throw err;
      ok = false;
    }
    ok ? applied++ : skipped++;
  }
  return { applied, skipped };
}

async function applyOne(db, op) {
  switch (op?.type) {
    case "upsert_collection": {
      const r = op.row;
      if (!ID(r?.id) || !STR(r?.name, 200) || !TS(r?.created_at) || !TS(r?.updated_at)) return false;
      const res = await db.prepare(
        `INSERT INTO collections (id, name, sort_order, archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET name=?2, sort_order=?3, archived=?4, updated_at=?6
         WHERE excluded.updated_at >= collections.updated_at`
      ).bind(r.id, r.name, NUM(r.sort_order), r.archived ? 1 : 0, r.created_at, r.updated_at).run();
      return res.meta.changes > 0;
    }
    case "delete_collection": {
      if (!ID(op.id)) return false;
      await db.prepare("DELETE FROM links WHERE collection_id = ?1").bind(op.id).run(); // links first: D1 enforces the foreign key, so the collection can't go while links point at it
      await db.prepare("DELETE FROM collections WHERE id = ?1").bind(op.id).run();
      return true;
    }
    case "upsert_link": {
      const r = op.row;
      if (!ID(r?.id) || !ID(r?.collection_id) || !validUrl(r?.url) || !STR(r?.url) || !STR(r?.title ?? "", 500) || !TS(r?.created_at) || !TS(r?.updated_at)) return false;
      // A link for a collection that isn't there (deleted on another computer, say) is
      // refused by rule, not treated as a database failure.
      if (!(await db.prepare("SELECT 1 AS ok FROM collections WHERE id = ?1").bind(r.collection_id).first())) return false;
      const res = await db.prepare(
        `INSERT INTO links (id, collection_id, url, title, sort_order, starred, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET collection_id=?2, url=?3, title=?4, sort_order=?5, starred=?6, updated_at=?8
         WHERE excluded.updated_at >= links.updated_at`
      ).bind(r.id, r.collection_id, r.url, r.title ?? "", NUM(r.sort_order), r.starred ? 1 : 0, r.created_at, r.updated_at).run();
      return res.meta.changes > 0;
    }
    case "delete_link": {
      if (!ID(op.id)) return false;
      await db.prepare("DELETE FROM links WHERE id = ?1").bind(op.id).run();
      return true;
    }
    case "click": {
      if (!ID(op.id) || !TS(op.at)) return false;
      // An older extension sends clicks with no op_id: count them as before.
      if (op.op_id === undefined) {
        const res = await db.prepare(
          `UPDATE links SET click_count = click_count + 1,
             last_clicked_at = CASE WHEN last_clicked_at IS NULL OR last_clicked_at < ?2 THEN ?2 ELSE last_clicked_at END
           WHERE id = ?1`
        ).bind(op.id, op.at).run();
        return res.meta.changes > 0;
      }
      if (!ID(op.op_id)) return false;
      // The extension resends a batch whose answer was lost, so a click can arrive twice.
      // Count it only if its op_id is new, and remember the op_id in the same transaction.
      const [res] = await db.batch([
        db.prepare(
          `UPDATE links SET click_count = click_count + 1,
             last_clicked_at = CASE WHEN last_clicked_at IS NULL OR last_clicked_at < ?2 THEN ?2 ELSE last_clicked_at END
           WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM click_ops WHERE op_id = ?3)`
        ).bind(op.id, op.at, op.op_id),
        db.prepare("INSERT OR IGNORE INTO click_ops (op_id, seen_at) VALUES (?1, ?2)").bind(op.op_id, new Date().toISOString()),
      ]);
      return res.meta.changes > 0;
    }
    default:
      return false;
  }
}
