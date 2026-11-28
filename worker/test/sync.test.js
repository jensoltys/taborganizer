// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { getState, applyOps } from "../src/sync.js";

const T1 = "2026-07-10T10:00:00.000Z";
const T2 = "2026-07-10T11:00:00.000Z";
const col = (o = {}) => ({ id: "c1", name: "Blogs", sort_order: 1, archived: 0, created_at: T1, updated_at: T1, ...o });
const link = (o = {}) => ({ id: "l1", collection_id: "c1", url: "https://a.com", title: "A", sort_order: 1, starred: 0, created_at: T1, updated_at: T1, ...o });

beforeEach(async () => {
  await env.DB.exec("DELETE FROM links; DELETE FROM collections; DELETE FROM click_ops;");
});

describe("applyOps", () => {
  it("inserts then LWW-updates a collection", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }]);
    await applyOps(env.DB, [{ type: "upsert_collection", row: col({ name: "Blogs v2", updated_at: T2 }) }]);
    const { collections } = await getState(env.DB);
    expect(collections[0].name).toBe("Blogs v2");
  });

  it("skips a stale upsert (older updated_at)", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col({ name: "new", updated_at: T2 }) }]);
    const r = await applyOps(env.DB, [{ type: "upsert_collection", row: col({ name: "old", updated_at: T1 }) }]);
    expect(r.skipped).toBe(1);
    const { collections } = await getState(env.DB);
    expect(collections[0].name).toBe("new");
  });

  it("click increments and never decrements", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    await applyOps(env.DB, [{ type: "click", id: "l1", at: T1 }, { type: "click", id: "l1", at: T2 }]);
    const { links } = await getState(env.DB);
    expect(links[0].click_count).toBe(2);
    expect(links[0].last_clicked_at).toBe(T2);
  });

  it("a click resent with the same op_id counts once (batch stored, answer lost, batch retried)", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    const batch = [{ type: "click", id: "l1", at: T1, op_id: "k1" }];
    expect(await applyOps(env.DB, batch)).toEqual({ applied: 1, skipped: 0 });
    expect(await applyOps(env.DB, batch)).toEqual({ applied: 0, skipped: 1 });
    await applyOps(env.DB, [{ type: "click", id: "l1", at: T2, op_id: "k2" }]);
    await applyOps(env.DB, [{ type: "click", id: "l1", at: T2 }]); // an older extension sends no op_id: still counts
    const { links } = await getState(env.DB);
    expect(links[0].click_count).toBe(3);
    expect(links[0].last_clicked_at).toBe(T2);
  });

  it("refuses a click whose op_id isn't a short string", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    const r = await applyOps(env.DB, [{ type: "click", id: "l1", at: T1, op_id: 7 }, { type: "click", id: "l1", at: T1, op_id: "x".repeat(65) }]);
    expect(r).toEqual({ applied: 0, skipped: 2 });
  });

  it("upsert_link cannot clobber click data", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    await applyOps(env.DB, [{ type: "click", id: "l1", at: T1 }]);
    await applyOps(env.DB, [{ type: "upsert_link", row: link({ title: "A2", updated_at: T2 }) }]);
    const { links } = await getState(env.DB);
    expect(links[0].title).toBe("A2");
    expect(links[0].click_count).toBe(1);
  });

  it("delete_collection cascades its links", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    await applyOps(env.DB, [{ type: "delete_collection", id: "c1" }]);
    const s = await getState(env.DB);
    expect(s.collections).toHaveLength(0);
    expect(s.links).toHaveLength(0);
  });

  it("rejects an op with an unknown type", async () => {
    const r = await applyOps(env.DB, [{ type: "explode" }]);
    expect(r.skipped).toBe(1);
  });

  it("rejects upsert_link with a non-http(s) url", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }]);
    const r = await applyOps(env.DB, [{ type: "upsert_link", row: link({ url: "javascript:alert(1)" }) }]);
    expect(r.skipped).toBe(1);
  });

  it("getState returns collections and links ordered by sort_order", async () => {
    await applyOps(env.DB, [
      { type: "upsert_collection", row: col({ id: "c1", sort_order: 2 }) },
      { type: "upsert_collection", row: col({ id: "c2", name: "B", sort_order: 1 }) },
      { type: "upsert_link", row: link({ id: "l1", sort_order: 2 }) },
      { type: "upsert_link", row: link({ id: "l2", url: "https://b.com", sort_order: 1 }) },
    ]);
    const { collections, links } = await getState(env.DB);
    expect(collections.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(links.map((l) => l.id)).toEqual(["l2", "l1"]);
  });

  it("click never moves last_clicked_at backward", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col() }, { type: "upsert_link", row: link() }]);
    await applyOps(env.DB, [{ type: "click", id: "l1", at: T2 }, { type: "click", id: "l1", at: T1 }]);
    const { links } = await getState(env.DB);
    expect(links[0].click_count).toBe(2);
    expect(links[0].last_clicked_at).toBe(T2);
  });

  it("delete_link removes just that link", async () => {
    await applyOps(env.DB, [
      { type: "upsert_collection", row: col() },
      { type: "upsert_link", row: link({ id: "l1" }) },
      { type: "upsert_link", row: link({ id: "l2", url: "https://b.com" }) },
    ]);
    await applyOps(env.DB, [{ type: "delete_link", id: "l1" }]);
    const { links } = await getState(env.DB);
    expect(links).toHaveLength(1);
    expect(links[0].id).toBe("l2");
  });

  it("LWW tie (equal updated_at) still applies the update", async () => {
    await applyOps(env.DB, [{ type: "upsert_collection", row: col({ name: "first" }) }]);
    const r = await applyOps(env.DB, [{ type: "upsert_collection", row: col({ name: "second", updated_at: T1 }) }]);
    expect(r.applied).toBe(1);
    const { collections } = await getState(env.DB);
    expect(collections[0].name).toBe("second");
  });
});

describe("applyOps: rules vs database failures", () => {
  it("refuses a link whose collection doesn't exist, without failing the batch", async () => {
    const r = await applyOps(env.DB, [
      { type: "upsert_link", row: link({ id: "orphan", collection_id: "nope" }) },
      { type: "upsert_collection", row: col() },
      { type: "upsert_link", row: link() },
    ]);
    expect(r).toEqual({ applied: 2, skipped: 1 });
    expect((await getState(env.DB)).links.map((l) => l.id)).toEqual(["l1"]);
  });

  it("refuses timestamps that aren't ISO, empty ids and non-finite sort orders are stored as 0", async () => {
    const r = await applyOps(env.DB, [
      { type: "upsert_collection", row: col({ updated_at: "9999" }) },
      { type: "upsert_collection", row: col({ id: "" }) },
      { type: "upsert_collection", row: col({ id: "c2", sort_order: "Infinity" }) },
      { type: "click", id: "l1", at: "yesterday" },
    ]);
    expect(r).toEqual({ applied: 1, skipped: 3 });
    expect((await getState(env.DB)).collections[0].sort_order).toBe(0);
  });

  it("lets a real database failure throw, so the sender keeps its queue", async () => {
    const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: Too many API requests by single Worker invocation"); } }) }) };
    await expect(applyOps(broken, [{ type: "upsert_collection", row: col() }])).rejects.toThrow("Too many");
  });

  it("counts an unforeseen constraint error as a skip, not a failure", async () => {
    const broken = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT"); } }) }) };
    expect(await applyOps(broken, [{ type: "upsert_collection", row: col() }])).toEqual({ applied: 0, skipped: 1 });
  });
});

describe("timestamps must be exactly what toISOString() writes", () => {
  it("refuses impossible dates and other precisions", async () => {
    const r = await applyOps(env.DB, [
      { type: "upsert_collection", row: col({ updated_at: "9999-99-99T99:99:99.999Z" }) },
      { type: "upsert_collection", row: col({ updated_at: "2026-07-10T10:00:00Z" }) },
      { type: "upsert_collection", row: col({ updated_at: "2026-07-10T10:00:00.5Z" }) },
      { type: "upsert_collection", row: col() },
    ]);
    expect(r).toEqual({ applied: 1, skipped: 3 });
  });
});
