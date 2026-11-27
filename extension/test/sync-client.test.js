// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
import { describe, it, expect } from "vitest";
import { applyOpLocal, compactQueue } from "../lib/sync.js";

const T1 = "2026-07-10T10:00:00.000Z";
const empty = { collections: [], links: [] };
const col = { id: "c1", name: "A", sort_order: 1, archived: 0, created_at: T1, updated_at: T1 };
const link = { id: "l1", collection_id: "c1", url: "https://a.com", title: "A", sort_order: 1, starred: 0, click_count: 0, last_clicked_at: null, created_at: T1, updated_at: T1 };

describe("applyOpLocal", () => {
  it("upserts a collection", () => {
    const s = applyOpLocal(empty, { type: "upsert_collection", row: col });
    expect(s.collections).toHaveLength(1);
  });
  it("does not mutate the input state", () => {
    applyOpLocal(empty, { type: "upsert_collection", row: col });
    expect(empty.collections).toHaveLength(0);
  });
  it("click increments locally", () => {
    let s = applyOpLocal(empty, { type: "upsert_collection", row: col });
    s = applyOpLocal(s, { type: "upsert_link", row: link });
    s = applyOpLocal(s, { type: "click", id: "l1", at: T1 });
    expect(s.links[0].click_count).toBe(1);
    expect(s.links[0].last_clicked_at).toBe(T1);
  });
  it("delete_collection removes its links", () => {
    let s = applyOpLocal(empty, { type: "upsert_collection", row: col });
    s = applyOpLocal(s, { type: "upsert_link", row: link });
    s = applyOpLocal(s, { type: "delete_collection", id: "c1" });
    expect(s.links).toHaveLength(0);
  });
});

describe("compactQueue", () => {
  it("keeps only the latest upsert per id", () => {
    const q = compactQueue([
      { type: "upsert_link", row: { ...link, title: "v1" } },
      { type: "upsert_link", row: { ...link, title: "v2" } },
    ]);
    expect(q).toHaveLength(1);
    expect(q[0].row.title).toBe("v2");
  });
  it("drops ops for ids deleted later", () => {
    const q = compactQueue([
      { type: "upsert_link", row: link },
      { type: "click", id: "l1", at: T1 },
      { type: "delete_link", id: "l1" },
    ]);
    expect(q).toEqual([{ type: "delete_link", id: "l1" }]);
  });
  it("preserves clicks for surviving links", () => {
    const q = compactQueue([{ type: "click", id: "l1", at: T1 }]);
    expect(q).toHaveLength(1);
  });
});

describe("compactQueue ordering (what the Worker can apply in order)", () => {
  it("keeps a collection ahead of its link when the collection is renamed afterwards", () => {
    const q = compactQueue([
      { type: "upsert_collection", row: col, _seq: "a" },
      { type: "upsert_link", row: link, _seq: "b" },
      { type: "upsert_collection", row: { ...col, name: "Renamed" }, _seq: "c" },
    ]);
    expect(q.map((o) => o.type)).toEqual(["upsert_collection", "upsert_link"]);
    expect(q[0].row.name).toBe("Renamed");
    expect(q[0]._seq).toBe("c"); // newest op's id, so an in-flight edit is never cleared by mistake
  });

  it("sends a collection made later before a link that was moved into it", () => {
    const q = compactQueue([
      { type: "upsert_link", row: link, _seq: "a" },
      { type: "upsert_collection", row: { ...col, id: "c2" }, _seq: "b" },
      { type: "upsert_link", row: { ...link, collection_id: "c2" }, _seq: "c" },
    ]);
    expect(q.map((o) => o.row.id)).toEqual(["c2", "l1"]);
    expect(q[1].row.collection_id).toBe("c2");
  });

  it("keeps a click behind the link it belongs to when the link is edited after the click", () => {
    const q = compactQueue([
      { type: "upsert_link", row: link, _seq: "a" },
      { type: "click", id: "l1", at: T1, _seq: "b" },
      { type: "upsert_link", row: { ...link, starred: 1 }, _seq: "c" },
    ]);
    expect(q.map((o) => o.type)).toEqual(["upsert_link", "click"]);
    expect(q[0].row.starred).toBe(1);
  });
});

describe("compactQueue: a link moved into a collection that is then deleted", () => {
  it("turns the link's move into a delete, so it can't come back in its old collection", () => {
    const q = compactQueue([
      { type: "upsert_collection", row: { ...col, id: "c2" }, _seq: "a" },
      { type: "upsert_link", row: { ...link, collection_id: "c2" }, _seq: "b" },
      { type: "delete_collection", id: "c2", _seq: "c" },
    ]);
    expect(q.map((o) => [o.type, o.id])).toEqual([["delete_link", "l1"], ["delete_collection", "c2"]]);
    expect(q[0]._seq).toBe("b");
  });
});
