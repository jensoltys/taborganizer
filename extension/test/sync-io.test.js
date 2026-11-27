// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
import { beforeEach, describe, it, expect, vi } from "vitest";
import { applyOpLocal, enqueue, flush, pull } from "../lib/sync.js";
import { getQueue, getState, setConfig, setQueue, setState } from "../lib/store.js";

const T1 = "2026-07-10T10:00:00.000Z";
const col = (id) => ({
  id,
  name: `Collection ${id}`,
  sort_order: 1,
  archived: 0,
  created_at: T1,
  updated_at: T1,
});

// fake chrome: clone on get and on set so reference identity never survives
function installChrome(initial = {}) {
  let store = structuredClone(initial);
  globalThis.chrome = {
    storage: {
      local: {
        get: (key) => Promise.resolve(structuredClone({ [key]: store[key] })),
        set: (obj) => {
          store = { ...store, ...structuredClone(obj) };
          return Promise.resolve();
        },
      },
    },
  };
  return () => store;
}

beforeEach(() => {
  installChrome({});
});

describe("flush (I/O, clone-safe storage)", () => {
  it("drains the queue after a successful POST", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ applied: 2, skipped: 0 }),
    }));

    await enqueue({ type: "upsert_collection", row: col("c1") });
    await enqueue({ type: "upsert_collection", row: col("c2") });

    await flush();

    const q = await getQueue();
    expect(q).toHaveLength(0);
  });

  it("picks up an op enqueued during the in-flight POST via single-flight re-run, without losing it or looping forever", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });

    // seed directly (bypassing enqueue's own background flush) so the only
    // flush() in play is the one this test drives explicitly
    await setQueue([
      { type: "upsert_collection", row: col("c1"), _seq: crypto.randomUUID() },
      { type: "upsert_collection", row: col("c2"), _seq: crypto.randomUUID() },
    ]);

    let fired = false;
    const fetchMock = vi.fn(async () => {
      // simulate a concurrent enqueue firing while the first POST is in
      // flight — gated to fire exactly once, otherwise the mock's own
      // enqueue() triggers another background flush() whose POST calls
      // this mock again, which enqueues again... an unbounded
      // flush→fetch→enqueue loop.
      if (!fired) {
        fired = true;
        await enqueue({ type: "upsert_collection", row: col("c3") });
      }
      return { ok: true, json: async () => ({ applied: 2, skipped: 0 }) };
    });
    globalThis.fetch = fetchMock;

    await flush();

    // Single-flight's do/while re-run catches c3 (enqueued mid-flight) in a
    // second pass before flush() resolves — nothing enqueued during the
    // flight is left stranded in the queue, and the mock only fired twice
    // (the gate proves the loop terminates instead of running away).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const q = await getQueue();
    expect(q).toHaveLength(0);
  });

  it("leaves the queue intact when the POST fails", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500 }));

    await enqueue({ type: "upsert_collection", row: col("c1") });

    await flush().catch(() => {});

    const q = await getQueue();
    expect(q.length).toBeGreaterThanOrEqual(1);
  });
});

describe("flush (single-flight coalescing)", () => {
  it("coalesces overlapping flush() calls into a single POST", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });

    // seed the queue directly with two _seq-tagged ops, bypassing enqueue's
    // own background flush so we control exactly when flush() is called
    await setQueue([
      { type: "upsert_collection", row: col("c1"), _seq: crypto.randomUUID() },
      { type: "upsert_collection", row: col("c2"), _seq: crypto.randomUUID() },
    ]);

    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return { ok: true, json: async () => ({}) };
    });
    globalThis.fetch = fetchMock;

    await Promise.all([flush(), flush(), flush()]); // three concurrent flush calls

    expect(fetchMock).toHaveBeenCalledTimes(1); // coalesced to a single POST
    expect(await getQueue()).toHaveLength(0); // queue drained
  });
});

describe("pull (I/O, TOCTOU guard)", () => {
  it("does not overwrite the cache with the server payload if an op lands in the queue while /api/state is in flight", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });

    // Queue starts empty so pull()'s pre-fetch guard passes and the fetch
    // actually goes out.
    await setQueue([]);
    const initialState = { collections: [], links: [] };
    await setState(initialState);

    // What a concurrent enqueue() would have persisted mid-flight: the op
    // applied to local state, plus itself sitting in the queue. Computed via
    // the same applyOpLocal() enqueue() uses internally, so this mirrors
    // reality without recursively triggering flush()/fetch from inside the
    // mock below.
    const localOp = { type: "upsert_collection", row: col("local-c"), _seq: crypto.randomUUID() };
    const locallyEnqueuedState = applyOpLocal(initialState, localOp);

    const serverState = { collections: [col("server-c")], links: [] };

    globalThis.fetch = vi.fn(async () => {
      // Fires after pull()'s pre-fetch queue-empty check already passed, but
      // before the network round-trip resolves — simulating an op enqueued
      // during the fetch.
      await setState(locallyEnqueuedState);
      await setQueue([localOp]);
      return { ok: true, json: async () => serverState };
    });

    const result = await pull();

    // The post-fetch re-check must see the now-nonempty queue and bail
    // before setState(server) — returning null and leaving the local op's
    // state in the cache instead of clobbering it with the stale server
    // payload (which is missing "local-c" and would add "server-c").
    expect(result).toBeNull();
    const state = await getState();
    expect(state).toEqual(locallyEnqueuedState);
    expect(state.collections.some((c) => c.id === "server-c")).toBe(false);
    expect(await getQueue()).toEqual([localOp]);
  });
});

describe("enqueue (I/O, concurrency)", () => {
  it("serializes concurrent enqueues so no op is lost", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ applied: 0, skipped: 0 }),
    }));

    await Promise.all([
      enqueue({ type: "upsert_collection", row: col("a") }),
      enqueue({ type: "upsert_collection", row: col("b") }),
      enqueue({ type: "upsert_collection", row: col("c") }),
    ]);

    const state = await getState();
    const ids = state.collections.map((c) => c.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("flush sends small batches and never drops what wasn't stored", () => {
  const seed = (n) => setQueue(Array.from({ length: n }, (_, i) => ({ type: "click", id: "l1", at: T1, _seq: `s${i}` })));

  it("sends 45 queued ops as 20 + 20 + 5 and empties the queue", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    await seed(45);
    const sizes = [];
    globalThis.fetch = vi.fn(async (_url, opts) => { sizes.push(JSON.parse(opts.body).ops.length); return { ok: true, json: async () => ({}) }; });
    await flush();
    expect(sizes).toEqual([20, 20, 5]);
    expect(await getQueue()).toHaveLength(0);
  });

  it("gets a 600-op queue through (the Worker caps one request at 500)", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    await seed(600);
    let max = 0;
    globalThis.fetch = vi.fn(async (_url, opts) => { max = Math.max(max, JSON.parse(opts.body).ops.length); return { ok: true, json: async () => ({}) }; });
    await flush();
    expect(max).toBeLessThanOrEqual(20);
    expect(await getQueue()).toHaveLength(0);
  });

  it("keeps everything unsent when a batch fails", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    await seed(45);
    let calls = 0;
    globalThis.fetch = vi.fn(async () => (++calls === 2 ? { ok: false, status: 500 } : { ok: true, json: async () => ({}) }));
    await expect(flush()).rejects.toThrow("HTTP 500");
    expect(await getQueue()).toHaveLength(25);
  });
});

describe("pull refuses an answer that isn't our data", () => {
  it("leaves the cached state alone when a 200 has the wrong shape", async () => {
    await setConfig({ apiUrl: "https://x", token: "t" });
    await setState({ collections: [col("c1")], links: [] });
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    await expect(pull()).rejects.toThrow("unexpected response");
    expect((await getState()).collections).toHaveLength(1);
  });
});
