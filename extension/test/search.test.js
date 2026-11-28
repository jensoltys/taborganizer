// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { describe, it, expect } from "vitest";
import { scoreLink, searchLinks } from "../lib/search.js";

const L = (o) => ({ id: "x", url: "https://example.com", title: "Example", click_count: 0, ...o });

describe("scoreLink", () => {
  it("prefix beats substring", () => {
    expect(scoreLink("ex", L({ title: "Example" }))).toBeGreaterThan(scoreLink("ex", L({ title: "My Example" })));
  });
  it("word-prefix beats bare substring", () => {
    expect(scoreLink("ex", L({ title: "My Example" }))).toBeGreaterThan(scoreLink("ex", L({ title: "Flex" })));
  });
  it("url matches when title does not", () => {
    expect(scoreLink("github", L({ title: "Repo", url: "https://github.com/x" }))).toBeGreaterThan(0);
  });
  it("subsequence needs 3+ chars", () => {
    expect(scoreLink("ab", L({ title: "axxbx" }))).toBe(0);
    expect(scoreLink("abc", L({ title: "axxbxxc" }))).toBeGreaterThan(0);
  });
  it("no match is zero", () => {
    expect(scoreLink("zzz", L({ title: "Example" }))).toBe(0);
  });
  it("substring(60) beats url-substring(40)", () => {
    expect(scoreLink("ample", L({ title: "Example", url: "https://x.com" }))).toBeGreaterThan(
      scoreLink("ample", L({ title: "Repo", url: "https://ample.com" }))
    );
  });
  it("url-substring(40) beats subsequence(20)", () => {
    expect(scoreLink("abc", L({ title: "Repo", url: "https://abc.com" }))).toBeGreaterThan(
      scoreLink("abc", L({ title: "aXbXc", url: "https://x.com" }))
    );
  });
  it("subsequence must be in order", () => {
    expect(scoreLink("cba", L({ title: "axxbxxc" }))).toBe(0);
  });
});

describe("searchLinks", () => {
  const collections = [{ id: "c1", name: "Work", archived: 0 }, { id: "c2", name: "Old", archived: 1 }];
  const links = [
    L({ id: "1", collection_id: "c1", title: "GitHub", click_count: 5 }),
    L({ id: "2", collection_id: "c2", title: "GitHub Old", click_count: 0 }),
  ];
  it("includes archived links, flagged", () => {
    const r = searchLinks("github", links, collections);
    expect(r).toHaveLength(2);
    expect(r.find((x) => x.link.id === "2").archived).toBe(true);
  });
  it("higher click_count wins ties", () => {
    const r = searchLinks("github", links, collections);
    expect(r[0].link.id).toBe("1");
  });
  it("empty query returns empty", () => {
    expect(searchLinks("", links, collections)).toHaveLength(0);
  });
  it("caps results at 12", () => {
    const manyLinks = Array.from({ length: 15 }, (_, i) =>
      L({ id: String(i + 1), collection_id: "c1", title: `git ${i + 1}` })
    );
    const r = searchLinks("git", manyLinks, collections);
    expect(r).toHaveLength(12);
  });
  it("collectionName is populated", () => {
    const r = searchLinks("github", links, collections);
    const c1Result = r.find((x) => x.link.id === "1");
    expect(c1Result.collectionName).toBe("Work");
  });
  it("whitespace-only query returns empty", () => {
    expect(searchLinks("   ", links, collections)).toHaveLength(0);
  });
  it("non-archived result flagged archived:false", () => {
    const r = searchLinks("github", links, collections);
    const c1Result = r.find((x) => x.link.id === "1");
    expect(c1Result.archived).toBe(false);
  });
});
