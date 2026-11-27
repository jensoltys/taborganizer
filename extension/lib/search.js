// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
export function scoreLink(query, link) {
  const q = query.toLowerCase();
  if (!q) return 0;
  const title = (link.title || "").toLowerCase();
  const url = (link.url || "").toLowerCase();
  if (title.startsWith(q)) return 100;
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 80;
  if (title.includes(q)) return 60;
  if (url.includes(q)) return 40;
  if (q.length >= 3 && isSubsequence(q, title)) return 20;
  return 0;
}

function isSubsequence(q, s) {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

export function searchLinks(query, links, collections) {
  if (!query.trim()) return [];
  const colById = Object.fromEntries(collections.map((c) => [c.id, c]));
  return links
    .map((link) => ({ link, score: scoreLink(query, link) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (b.link.click_count || 0) - (a.link.click_count || 0))
    .slice(0, 12)
    .map(({ link }) => {
      const col = colById[link.collection_id];
      return { link, collectionName: col?.name || "", archived: !!col?.archived };
    });
}
