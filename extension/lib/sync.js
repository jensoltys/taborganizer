// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { getConfig, getState, setState, getQueue, setQueue } from "./store.js";

// ---------- pure ----------
export function applyOpLocal(state, op) {
  const s = { collections: [...state.collections], links: [...state.links] };
  const upsert = (arr, row) => {
    const i = arr.findIndex((r) => r.id === row.id);
    if (i === -1) arr.push({ ...row });
    else arr[i] = { ...arr[i], ...row };
  };
  switch (op.type) {
    case "upsert_collection": upsert(s.collections, op.row); break;
    case "delete_collection":
      s.collections = s.collections.filter((c) => c.id !== op.id);
      s.links = s.links.filter((l) => l.collection_id !== op.id);
      break;
    case "upsert_link": upsert(s.links, op.row); break;
    case "delete_link": s.links = s.links.filter((l) => l.id !== op.id); break;
    case "click":
      s.links = s.links.map((l) => l.id === op.id
        ? { ...l, click_count: (l.click_count || 0) + 1, last_clicked_at: op.at }
        : l);
      break;
  }
  return s;
}

// Shrinks the queue before sending: one upsert per row (the newest content), nothing
// for rows that were deleted. ORDER MATTERS, because the Worker applies ops one by one:
//   - every collection upsert goes first, so a link never arrives before the collection
//     it belongs to (the database refuses a link whose collection doesn't exist yet)
//   - a link's upsert keeps the position of its FIRST upsert, so a click queued after
//     the link was created still finds the link
// Every other op is safe to send twice. A click isn't, so doFlush sends each one with
// its _seq as op_id and the Worker counts an op_id only once (a batch can be stored
// while its answer is lost, then sent again).
// The merged op carries the newest op's _seq. flush() clears by _seq, so an edit made
// while a send is in flight has a _seq that wasn't sent and stays queued.
export function compactQueue(ops) {
  const deleted = new Set(
    ops.filter((o) => o.type === "delete_link" || o.type === "delete_collection").map((o) => o.id)
  );
  const isUpsert = (o) => o.type.startsWith("upsert_");
  const key = (o) => `${o.type}:${o.row.id}`;
  const first = new Map(); // key -> index of first upsert
  const newest = new Map(); // key -> the last upsert op
  ops.forEach((o, i) => {
    if (!isUpsert(o)) return;
    if (!first.has(key(o))) first.set(key(o), i);
    newest.set(key(o), o);
  });
  const collections = [];
  const rest = [];
  ops.forEach((o, i) => {
    if (isUpsert(o)) {
      if (deleted.has(o.row.id) || first.get(key(o)) !== i) return;
      const latest = newest.get(key(o));
      if (o.type === "upsert_link" && deleted.has(latest.row.collection_id)) {
        // The link's newest home is a collection deleted in this same queue. Deleting the
        // collection already removed the link here, so say so plainly to the Worker too.
        // (If the collection never reached the Worker, its delete alone wouldn't touch a
        // link that still sits in its old collection over there.)
        rest.push({ type: "delete_link", id: latest.row.id, _seq: latest._seq });
        return;
      }
      (o.type === "upsert_collection" ? collections : rest).push(latest);
    } else if (o.type === "click") {
      if (!deleted.has(o.id)) rest.push(o);
    } else {
      rest.push(o); // deletes always survive
    }
  });
  return [...collections, ...rest];
}

// ---------- I/O ----------
async function api(path, opts = {}) {
  const { apiUrl, token } = await getConfig();
  if (!apiUrl || !token) throw new Error("not configured");
  const r = await fetch(apiUrl + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...opts.headers },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Serializes queue/state mutations so concurrent enqueue()/flush() calls
// (which each do a read-modify-write across chrome.storage awaits) never
// interleave and clobber each other. chrome.storage.local returns a fresh
// structured clone on every get, so object identity never survives a
// round-trip — mutual exclusion has to be explicit.
let mutationTail = Promise.resolve();
function withLock(fn) {
  const run = mutationTail.then(fn, fn);
  mutationTail = run.then(() => {}, () => {});
  return run;
}

export async function enqueue(op) {
  const state = await withLock(async () => {
    const stamped = { ...op, _seq: crypto.randomUUID() };
    const s = applyOpLocal(await getState(), stamped);
    await setState(s);
    await setQueue([...(await getQueue()), stamped]);
    return s;
  });
  flush().catch(() => {}); // background; failures stay queued
  return state;
}

// Single-flight coalescing: overlapping flush() calls share one in-flight
// run. If new ops are enqueued while a flush is in progress, flushRequested
// causes one more pass after the current one finishes, instead of spawning
// an overlapping request that would re-send not-yet-cleared ops (e.g.
// double-counting click increments server-side).
let flushing = null;
let flushRequested = false;

export function flush() {
  if (flushing) { flushRequested = true; return flushing; }
  flushing = (async () => {
    try {
      do {
        flushRequested = false;
        await doFlush();
      } while (flushRequested);
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

// Ops go up in small batches. Cloudflare's free plan allows 50 database queries per
// Worker request and one op can cost two, so a long offline queue sent in one request
// would fail partway. Each batch is cleared from the queue only after the Worker says
// it stored it; a failed batch throws and everything unsent stays queued.
const FLUSH_BATCH = 20;

async function doFlush() {
  for (;;) {
    const ops = compactQueue(await getQueue()).slice(0, FLUSH_BATCH);
    if (ops.length === 0) return; // queue already empty: no send, no unlocked write
    const sentSeqs = new Set(ops.map((o) => o._seq));
    await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({ ops: ops.map(({ _seq, ...rest }) => (rest.type === "click" && _seq ? { ...rest, op_id: _seq } : rest)) }),
    });
    // Clear exactly what we sent (by stable _seq id, not object identity);
    // anything enqueued during the request survives.
    await withLock(async () => {
      const current = compactQueue(await getQueue());
      await setQueue(current.filter((o) => !sentSeqs.has(o._seq)));
    });
  }
}

export async function pull() {
  if ((await getQueue()).length > 0) return null; // never clobber unflushed ops
  const state = await api("/api/state");
  // A wrong address can answer 200 with something that isn't our data. Never cache that.
  if (!state || !Array.isArray(state.collections) || !Array.isArray(state.links)) throw new Error("unexpected response");
  // Re-check after the network round-trip: an op enqueued while the fetch
  // was in flight is still safely sitting in the queue (and will self-heal
  // on the next flush), but the `state` we just fetched is now stale
  // relative to it. Overwriting the cache here would visually clobber that
  // op even though it survives — so skip setState and return null instead,
  // exactly like the pre-fetch guard above.
  if ((await getQueue()).length > 0) return null;
  await setState(state);
  return state;
}

export async function syncCycle() {
  try { await flush(); await pull(); } catch { /* offline is fine; cache is truth */ }
  return getState();
}
