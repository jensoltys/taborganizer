// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { getState, getConfig } from "../lib/store.js";
import { enqueue, syncCycle } from "../lib/sync.js";
import { uuid, nowIso, faviconUrl } from "../lib/util.js";
import { searchLinks } from "../lib/search.js";

let state = { collections: [], links: [] };
let showArchived = false;
// True only while the very first sync is in flight on a cold (empty) cache, so
// renderCollections shows "Loading…" instead of the blank/create-first state.
let loading = false;

const $ = (id) => document.getElementById(id);
const collectionTpl = $("collection-tpl");
const collectionsEl = $("collections");
const frequentEl = $("frequent");
const openTabsListEl = $("open-tabs-list");
const showArchivedBtn = $("show-archived");
const searchEl = $("search");
const searchResultsEl = $("search-results");

async function init() {
  // No Worker set up yet: everything still works from this browser's storage.
  // Show a small way into Options so syncing is one click away.
  getConfig().then((c) => {
    if (c.apiUrl && c.token) return;
    const b = $("setup-sync");
    b.hidden = false;
    b.addEventListener("click", () => chrome.runtime.openOptionsPage());
  });
  state = await getState(); // instant paint from cache
  // If the cache was cold (e.g. first run, or after a Chrome data clear), show a
  // loading state during the network pull instead of a blank/create-first page.
  loading = state.collections.length === 0;
  render();
  state = await syncCycle(); // background refresh
  loading = false;
  render();
}

function render() {
  renderFrequent();
  renderCollections();
  renderOpenTabs();
}

// Native HTML5 drag doesn't auto-scroll, so a drop target below/above the fold
// is unreachable. While a drag is in progress, scroll the page (and the
// internally-scrolling open-tabs list) when the pointer nears a viewport edge.
const DRAG_EDGE = 64;
const DRAG_SPEED = 20;
document.addEventListener("dragover", (e) => {
  const y = e.clientY;
  const vh = window.innerHeight;
  if (y < DRAG_EDGE) window.scrollBy(0, -DRAG_SPEED);
  else if (y > vh - DRAG_EDGE) window.scrollBy(0, DRAG_SPEED);

  const list = openTabsListEl;
  if (list) {
    const r = list.getBoundingClientRect();
    if (y >= r.top && y <= r.bottom && r.height > 0) {
      if (y < r.top + DRAG_EDGE) list.scrollTop -= DRAG_SPEED;
      else if (y > r.bottom - DRAG_EDGE) list.scrollTop += DRAG_SPEED;
    }
  }
});

// ---------- helpers ----------

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// The worker rejects upsert_link.title > 500 chars and upsert_collection.name
// > 200 chars, counting the row as skipped rather than erroring. Clamping
// here — at every emit site — means the client never sends a value the
// server will reject; without this, an over-long title/name applies+renders
// locally, then silently vanishes on the next pull() when the server's
// truncated view (missing that row) overwrites the cache. URLs are
// deliberately NOT clamped: truncating one would corrupt it, and an
// over-long URL from a real tab is vanishingly rare.
const clampTitle = (s) => (s || "").slice(0, 500);
const clampName = (s) => (s || "").slice(0, 200);

// Builds an upsert_link row from an existing link plus overrides, and
// deliberately excludes click_count/last_clicked_at: those are server-owned
// counters mutated only via {type:"click"} ops, never via upsert_link.
function linkRow(link, overrides = {}) {
  const merged = {
    id: link.id,
    collection_id: link.collection_id,
    url: link.url,
    title: link.title,
    sort_order: link.sort_order,
    starred: link.starred,
    created_at: link.created_at,
    updated_at: nowIso(),
    ...overrides,
  };
  return { ...merged, title: clampTitle(merged.title) };
}

function maxSortOrder(items) {
  return items.reduce((max, item) => Math.max(max, Number(item.sort_order) || 0), 0);
}

// Sort_order for appending to the end of a (possibly empty) collection.
// Empty collection -> maxSortOrder([]) === 0, so this returns 1.
function nextSortInCollection(collectionId) {
  return maxSortOrder(linksForCollection(collectionId)) + 1;
}

// Generic drag-reorder math shared by link rows and collection cards:
// `orderedItems` is the visual order the user sees (already excluding the
// item being dragged); `beforeId` is the id to insert before, or null/absent
// to append at the end. Returns a sort_order placed at the midpoint of its
// new neighbors, handling the empty-list/first/last edge cases.
function midpointSortOrder(orderedItems, beforeId) {
  if (orderedItems.length === 0) return 1;
  const idx = beforeId == null ? -1 : orderedItems.findIndex((it) => it.id === beforeId);
  const targetIdx = idx === -1 ? orderedItems.length : idx;
  const prev = targetIdx > 0 ? orderedItems[targetIdx - 1] : null;
  const next = targetIdx < orderedItems.length ? orderedItems[targetIdx] : null;
  if (prev && next) return (Number(prev.sort_order) + Number(next.sort_order)) / 2;
  if (!prev && next) return Number(next.sort_order) - 1;
  if (prev && !next) return Number(prev.sort_order) + 1;
  return 1;
}

async function applyOp(op) {
  state = await enqueue(op);
  render();
}

function linksForCollection(collectionId) {
  return state.links
    .filter((l) => l.collection_id === collectionId)
    .sort((a, b) => (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
}

// ---------- frequent row ----------

function renderFrequent() {
  frequentEl.replaceChildren();
  const archivedIds = new Set(state.collections.filter((c) => c.archived).map((c) => c.id));
  const top = state.links
    .filter((l) => (l.click_count || 0) > 0 && !archivedIds.has(l.collection_id))
    .sort((a, b) => {
      const byCount = (b.click_count || 0) - (a.click_count || 0);
      if (byCount !== 0) return byCount;
      // Date.parse(0) is NaN, so guard the falsy case explicitly rather than
      // Date.parse(x || 0) — that pattern still yields NaN and breaks the sort.
      const clickTime = (x) => (x ? Date.parse(x) : 0);
      return clickTime(b.last_clicked_at) - clickTime(a.last_clicked_at);
    })
    .slice(0, 8);

  frequentEl.hidden = top.length === 0;
  for (const link of top) {
    const a = document.createElement("a");
    a.className = "frequent-tile";
    if (isHttpUrl(link.url)) a.href = link.url; // only web addresses become real links
    const img = document.createElement("img");
    img.src = faviconUrl(link.url);
    img.width = 28;
    img.height = 28;
    img.alt = "";
    const span = document.createElement("span");
    span.textContent = link.title || hostnameOf(link.url);
    a.append(img, span);
    a.addEventListener("click", (e) => handleLinkActivate(e, link));
    a.addEventListener("auxclick", (e) => handleLinkActivate(e, link));
    frequentEl.appendChild(a);
  }
}

// ---------- collections ----------

// Collection-menu popovers (wireMenu) register their close() here while
// open. A full renderCollections() wipes the DOM out from under any popover
// that's still open (e.g. a background syncCycle() firing mid-menu), which
// left its document-level click/keydown listeners attached forever with no
// way to reach them again. Closing everything here first guarantees that
// never accumulates, without changing anything about how the menus behave.
const openMenuClosers = new Set();

function renderCollections() {
  for (const close of [...openMenuClosers]) close();
  collectionsEl.replaceChildren();

  if (state.collections.length === 0) {
    const wrap = document.createElement("div");
    wrap.className = "empty-collections";
    if (loading) {
      const msg = document.createElement("p");
      msg.className = "loading-msg";
      msg.textContent = "Loading your links…";
      wrap.appendChild(msg);
    } else {
      const btn = document.createElement("button");
      btn.className = "create-first-card";
      btn.textContent = "Create your first collection";
      btn.addEventListener("click", createCollection);
      wrap.appendChild(btn);
    }
    collectionsEl.appendChild(wrap);
    return;
  }

  const visible = state.collections
    .filter((c) => showArchived || !c.archived)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  for (const collection of visible) {
    collectionsEl.appendChild(buildCollectionCard(collection));
  }

  const ghost = document.createElement("button");
  ghost.type = "button";
  ghost.className = "new-collection-card";
  ghost.textContent = "New collection";
  ghost.addEventListener("click", createCollection);
  collectionsEl.appendChild(ghost);
}

function createCollection() {
  const name = window.prompt("Collection name?");
  if (!name || !name.trim()) return;
  applyOp({
    type: "upsert_collection",
    row: {
      id: uuid(),
      name: clampName(name.trim()),
      sort_order: maxSortOrder(state.collections) + 1,
      archived: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  });
}

function buildCollectionCard(collection) {
  const node = collectionTpl.content.firstElementChild.cloneNode(true);
  node.classList.toggle("archived", !!collection.archived);
  node.dataset.id = collection.id;
  // The template marks the whole card draggable="true" for the no-JS/base
  // case; drag-to-reorder collections should only start from the header,
  // so the card itself is not a drag source here.
  node.draggable = false;

  const nameEl = node.querySelector(".collection-name");
  nameEl.textContent = collection.name;
  wireRename(nameEl, collection);

  node.querySelector(".open-all").addEventListener("click", () => openAll(collection));
  wireMenu(node.querySelector(".menu-btn"), node.querySelector(".collection-actions"), collection);

  const headerEl = node.querySelector(".collection-head");
  wireCollectionDragSource(headerEl, node, collection);
  wireCollectionDropTarget(node, collection);

  const listEl = node.querySelector(".link-list");
  const links = linksForCollection(collection.id);
  if (links.length === 0) {
    const hint = document.createElement("li");
    hint.className = "empty-hint";
    hint.textContent = "Drag a tab here or paste a link";
    listEl.appendChild(hint);
  } else {
    for (const link of links) listEl.appendChild(buildLinkRow(link, collection));
  }

  wireAddLinkForm(node.querySelector(".add-link"), collection);

  return node;
}

// Drag source: only the card header initiates a collection reorder drag,
// so dragging inside the link list / add-link form doesn't pick up the
// whole card by accident.
function wireCollectionDragSource(headerEl, cardEl, collection) {
  headerEl.draggable = true;
  headerEl.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-collection", JSON.stringify({ collectionId: collection.id }));
    cardEl.classList.add("dragging");
  });
  headerEl.addEventListener("dragend", () => cardEl.classList.remove("dragging"));
}

// Single drop target per collection card: branches on whichever payload
// type is present (a dropped open tab, a link being moved/reordered, or a
// collection being reordered). Link rows nested inside intercept and stop
// propagation for application/x-link drops that target a specific row
// (see wireLinkDropTarget); everything else bubbles up to here.
function wireCollectionDropTarget(node, collection) {
  const acceptedTypes = ["application/x-tab", "application/x-link", "application/x-collection"];
  node.addEventListener("dragover", (e) => {
    if (!acceptedTypes.some((t) => e.dataTransfer.types.includes(t))) return;
    e.preventDefault();
    node.classList.add("drop-target");
  });
  node.addEventListener("dragleave", (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove("drop-target");
  });
  node.addEventListener("drop", (e) => {
    if (!acceptedTypes.some((t) => e.dataTransfer.types.includes(t))) return;
    e.preventDefault();
    node.classList.remove("drop-target");
    if (e.dataTransfer.types.includes("application/x-tab")) {
      handleTabDrop(e, collection);
    } else if (e.dataTransfer.types.includes("application/x-collection")) {
      handleCollectionReorderDrop(e, collection);
    } else if (e.dataTransfer.types.includes("application/x-link")) {
      handleLinkDrop(e, collection, null); // no specific row: append
    }
  });
}

// The tab being dragged out of this page's Open tabs list right now (null when none).
let draggingTabId = null;

// Saves a dropped-in open tab as a link, then closes the tab (saved =
// closed). Both chrome calls are guarded so a mid-flight
// failure (tab already closed, sync offline) can't wedge the drop.
async function handleTabDrop(e, collection) {
  let data;
  try {
    data = JSON.parse(e.dataTransfer.getData("application/x-tab"));
  } catch {
    return;
  }
  // Only a drag that started on this page's own Open tabs list counts. A drag from
  // any other page or app can carry the same data type, and must never save or close
  // a tab here.
  const started = draggingTabId;
  draggingTabId = null;
  if (!data || !Number.isInteger(data.tabId) || data.tabId !== started) return;

  // The drop payload is only a pointer. Anything can put data on a drag, so
  // look the tab up in Chrome and use what Chrome says: it must be a real
  // open tab on an http(s) page, or the drop is ignored (nothing saved,
  // nothing closed).
  let tab;
  try {
    tab = await chrome.tabs.get(data.tabId);
  } catch {
    return;
  }
  if (!tab || !isHttpUrl(tab.url)) return;
  data = { tabId: tab.id, url: tab.url, title: tab.title || "" };

  try {
    await applyOp({
      type: "upsert_link",
      row: {
        id: uuid(),
        collection_id: collection.id,
        url: data.url,
        title: clampTitle(data.title || hostnameOf(data.url)),
        sort_order: nextSortInCollection(collection.id),
        starred: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    });
  } catch {
    return; // couldn't save; leave the tab open
  }

  try {
    await chrome.tabs.remove(data.tabId);
  } catch {
    /* tab may already be gone; the link is saved either way */
  }
  // No explicit render() here: applyOp() above already re-rendered with the
  // new link, and the open-tabs list updates itself via the
  // chrome.tabs.onRemoved listener once the tab actually closes.
}

// Moves/reorders a link: dropping on a link row inserts before it
// (beforeLinkId set); dropping on collection body/empty space appends
// (beforeLinkId null). Deliberately builds the upsert_link row via
// linkRow() so click_count/last_clicked_at are never touched here.
function handleLinkDrop(e, targetCollection, beforeLinkId) {
  let payload;
  try {
    payload = JSON.parse(e.dataTransfer.getData("application/x-link"));
  } catch {
    return;
  }
  const link = state.links.find((l) => l.id === payload?.linkId);
  if (!link) return;
  if (link.id === beforeLinkId) return; // dropped on itself: no-op

  const siblings = linksForCollection(targetCollection.id).filter((l) => l.id !== link.id);
  const sortOrder = midpointSortOrder(siblings, beforeLinkId);

  applyOp({
    type: "upsert_link",
    row: linkRow(link, {
      collection_id: targetCollection.id,
      sort_order: sortOrder,
      updated_at: nowIso(),
    }),
  });
}

// Reorders collections: drop target collection becomes the "insert before"
// anchor among the currently-visible, non-dragged collections.
function handleCollectionReorderDrop(e, targetCollection) {
  let payload;
  try {
    payload = JSON.parse(e.dataTransfer.getData("application/x-collection"));
  } catch {
    return;
  }
  const dragged = state.collections.find((c) => c.id === payload?.collectionId);
  if (!dragged || dragged.id === targetCollection.id) return;

  const ordered = state.collections
    .filter((c) => (showArchived || !c.archived) && c.id !== dragged.id)
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const sortOrder = midpointSortOrder(ordered, targetCollection.id);

  applyOp({
    type: "upsert_collection",
    row: { ...dragged, sort_order: sortOrder, updated_at: nowIso() },
  });
}

function wireRename(nameEl, collection) {
  const save = () => {
    nameEl.contentEditable = "false";
    const name = nameEl.textContent.trim();
    if (!name || name === collection.name) {
      nameEl.textContent = collection.name;
      return;
    }
    applyOp({
      type: "upsert_collection",
      row: { ...collection, name: clampName(name), updated_at: nowIso() },
    });
  };
  nameEl.addEventListener("blur", save);
  nameEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameEl.blur();
    }
  });
  // Rename entry point lives in the menu (wireMenu); expose a starter here.
  nameEl._startRename = () => {
    nameEl.contentEditable = "true";
    nameEl.focus();
    const range = document.createRange();
    range.selectNodeContents(nameEl);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
}

function wireMenu(menuBtn, actionsEl, collection) {
  let popover = null;

  const close = () => {
    if (popover) { popover.remove(); popover = null; }
    document.removeEventListener("click", onOutsideClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    openMenuClosers.delete(close);
  };
  const onOutsideClick = (e) => {
    if (popover && !popover.contains(e.target) && e.target !== menuBtn) close();
  };
  const onKeydown = (e) => {
    if (e.key === "Escape") close();
  };

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popover) { close(); return; }

    popover = document.createElement("div");
    popover.className = "menu-popover";
    popover.setAttribute("role", "menu");

    const renameBtn = document.createElement("button");
    renameBtn.className = "muted-btn";
    renameBtn.setAttribute("role", "menuitem");
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", () => {
      close();
      const nameEl = actionsEl.closest(".collection").querySelector(".collection-name");
      nameEl._startRename();
    });

    const archiveBtn = document.createElement("button");
    archiveBtn.className = "muted-btn";
    archiveBtn.setAttribute("role", "menuitem");
    archiveBtn.textContent = collection.archived ? "Unarchive" : "Archive";
    archiveBtn.addEventListener("click", () => {
      close();
      applyOp({
        type: "upsert_collection",
        row: { ...collection, archived: collection.archived ? 0 : 1, updated_at: nowIso() },
      });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "muted-btn danger";
    deleteBtn.setAttribute("role", "menuitem");
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      close();
      const count = state.links.filter((l) => l.collection_id === collection.id).length;
      if (!window.confirm(`Delete collection and its ${count} links?`)) return;
      applyOp({ type: "delete_collection", id: collection.id });
    });

    popover.append(renameBtn, archiveBtn, deleteBtn);
    actionsEl.appendChild(popover);
    renameBtn.focus();

    openMenuClosers.add(close);
    document.addEventListener("click", onOutsideClick, true);
    document.addEventListener("keydown", onKeydown, true);
  });
}

// Bulk action, not per-link intent: deliberately emits no click ops so
// Frequent stays a signal of what you actually open,
// not what open-all happened to spray across a dozen tabs. Each tab creation
// is guarded independently so one failure (e.g. a since-deleted profile,
// Chrome refusing to open some URL scheme) can't abort the rest of the batch.
function openAll(collection) {
  for (const link of linksForCollection(collection.id)) {
    if (!isHttpUrl(link.url)) continue; // never open a non-web address
    try {
      // chrome.tabs.create returns a Promise in MV3; catch the async rejection
      // (bad URL scheme, closed window) as well as any synchronous throw so one
      // failure can't abort the rest of the batch.
      chrome.tabs.create({ url: link.url, active: false }).catch(() => {});
    } catch {
      /* this tab failed to open; keep going with the rest of the collection */
    }
  }
}

function wireAddLinkForm(form, collection) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.querySelector("input");
    const value = input.value.trim();
    if (!isHttpUrl(value)) {
      input.setCustomValidity("Enter a valid http(s) URL");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    const existing = state.links.filter((l) => l.collection_id === collection.id);
    applyOp({
      type: "upsert_link",
      row: {
        id: uuid(),
        collection_id: collection.id,
        url: value,
        title: clampTitle(hostnameOf(value)),
        sort_order: maxSortOrder(existing) + 1,
        starred: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    });
    input.value = "";
  });
}

function buildLinkRow(link, collection) {
  const li = document.createElement("li");
  li.className = "link-item";
  li.classList.toggle("starred", !!link.starred);

  const a = document.createElement("a");
  a.className = "link-row";
  if (isHttpUrl(link.url)) a.href = link.url; // only web addresses become real links

  const img = document.createElement("img");
  img.className = "favicon";
  img.src = faviconUrl(link.url);
  img.width = 16;
  img.height = 16;
  img.alt = "";

  const title = document.createElement("span");
  title.className = "link-title";
  title.textContent = link.title || hostnameOf(link.url);

  a.append(img, title);
  a.addEventListener("click", (e) => handleLinkActivate(e, link));
  a.addEventListener("auxclick", (e) => handleLinkActivate(e, link));

  // The anchor is a native drag source (it has an href); we don't cancel
  // that, just attach our own payload alongside it. dragstart never fires
  // a click, so this can't interfere with handleLinkActivate above.
  a.addEventListener("dragstart", (e) => {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-link", JSON.stringify({ linkId: link.id }));
    li.classList.add("dragging");
  });
  a.addEventListener("dragend", () => li.classList.remove("dragging"));
  wireLinkDropTarget(li, link, collection);

  const actions = document.createElement("div");
  actions.className = "link-actions";

  const starBtn = document.createElement("button");
  starBtn.className = "muted-btn";
  starBtn.textContent = link.starred ? "Unstar" : "Star";
  starBtn.addEventListener("click", () => {
    applyOp({ type: "upsert_link", row: linkRow(link, { starred: link.starred ? 0 : 1 }) });
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "muted-btn danger";
  deleteBtn.textContent = "Delete";
  deleteBtn.addEventListener("click", () => {
    applyOp({ type: "delete_link", id: link.id });
  });

  actions.append(starBtn, deleteBtn);
  li.append(a, actions);
  return li;
}

// Drop target for reordering: only application/x-link is handled here
// (insert before this row), and propagation is stopped so the collection's
// own drop handler doesn't also treat it as an append. Dropped tabs and
// dragged collections are ignored here and bubble up to the card level.
function wireLinkDropTarget(li, link, collection) {
  li.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-link")) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.add("drop-target");
  });
  li.addEventListener("dragleave", (e) => {
    if (!li.contains(e.relatedTarget)) li.classList.remove("drop-target");
  });
  li.addEventListener("drop", (e) => {
    if (!e.dataTransfer.types.includes("application/x-link")) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove("drop-target");
    handleLinkDrop(e, collection, link.id);
  });
}

function handleLinkActivate(e, link) {
  // Right-click (auxclick with button 2) opens the context menu; ignore it.
  if (e.type === "auxclick" && e.button !== 1) return;

  const modified = e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
  applyOp({ type: "click", id: link.id, at: nowIso() });

  if (modified) return; // let the browser open a new tab natively
  e.preventDefault();
  if (!isHttpUrl(link.url)) return; // never navigate to a non-web address
  location.href = link.url;
}

// ---------- open tabs panel ----------
//
// Renders the live list of open tabs in the current window as draggable
// rows (dragged onto a collection card, they're saved as a link and the
// source tab is closed — see handleTabDrop). New-tab pages themselves
// carry a chrome://newtab-ish URL that fails the http(s) filter below, so
// this window's own tab drops out without any special-casing.

async function renderOpenTabs() {
  if (!chrome.tabs) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {
    return; // tabs API unavailable in this context; leave prior render as-is
  }

  openTabsListEl.replaceChildren(...tabs
    .filter((t) => t.url && /^https?:/.test(t.url))
    .map((t) => {
      const li = document.createElement("li");
      li.className = "open-tab-row"; // reuses the link-row styling (hover, ellipsis)
      li.draggable = true;
      li.dataset.tabId = t.id;
      li.dataset.url = t.url;
      li.dataset.title = t.title || "";
      // A plain <li> with only a click listener isn't in the tab order and
      // has no keyboard activation. role="button" + tabindex="0" make it
      // reachable, and it's already covered by the global keydown-to-search
      // guard (INTERACTIVE_SELECTOR includes [role="button"]).
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `Switch to tab: ${t.title || t.url}`);

      const img = document.createElement("img");
      img.src = t.favIconUrl || faviconUrl(t.url);
      img.width = 16;
      img.height = 16;
      img.alt = "";

      const span = document.createElement("span");
      span.textContent = t.title || t.url;

      li.append(img, span);
      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-tab", JSON.stringify({ tabId: t.id, url: t.url, title: t.title || "" }));
        draggingTabId = t.id;
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => { draggingTabId = null; li.classList.remove("dragging"); });
      const activate = () => {
        chrome.tabs.update(t.id, { active: true }).catch(() => {});
        chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      };
      li.addEventListener("click", activate);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      return li;
    }));
}

if (chrome.tabs) {
  chrome.tabs.onRemoved.addListener(renderOpenTabs);
  chrome.tabs.onCreated.addListener(renderOpenTabs);
  chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") renderOpenTabs(); });
}

// ---------- type-to-launch search ----------
//
// Read-only over `state` except for the click op recorded on selection
// (same {type:"click", id, at} shape handleLinkActivate uses, so a search
// launch also updates the Frequent row / click_count like any other open).

let searchResults = []; // current searchLinks() output, [] when there's nothing to show
let activeIndex = -1; // index into searchResults, -1 = none highlighted

function openSearchResults() {
  searchResultsEl.hidden = false;
  searchEl.setAttribute("aria-expanded", "true");
}

function closeSearchResults() {
  searchResultsEl.hidden = true;
  searchResultsEl.replaceChildren();
  searchEl.setAttribute("aria-expanded", "false");
  searchEl.removeAttribute("aria-activedescendant");
  searchResults = [];
  activeIndex = -1;
}

function setActiveIndex(index) {
  for (const row of searchResultsEl.querySelectorAll(".search-result")) row.classList.remove("active");
  if (index < 0 || index >= searchResults.length) {
    activeIndex = -1;
    searchEl.removeAttribute("aria-activedescendant");
    return;
  }
  activeIndex = index;
  const row = searchResultsEl.querySelector(`#search-result-${index}`);
  if (!row) return;
  row.classList.add("active");
  searchEl.setAttribute("aria-activedescendant", row.id);
  row.scrollIntoView({ block: "nearest" });
}

function buildSearchResultRow(result, index) {
  const { link, collectionName, archived } = result;
  const li = document.createElement("li");
  li.id = `search-result-${index}`;
  li.className = "search-result";
  li.setAttribute("role", "option");

  const img = document.createElement("img");
  img.className = "favicon";
  img.src = faviconUrl(link.url);
  img.width = 16;
  img.height = 16;
  img.alt = "";

  const title = document.createElement("span");
  title.className = "search-result-title";
  title.textContent = link.title || hostnameOf(link.url);

  li.append(img, title);

  if (collectionName) {
    li.appendChild(document.createTextNode(" "));
    const col = document.createElement("span");
    col.className = "search-result-meta muted";
    col.textContent = collectionName;
    li.appendChild(col);
  }

  if (archived) {
    li.appendChild(document.createTextNode(" "));
    const arch = document.createElement("span");
    arch.className = "search-result-meta muted";
    arch.textContent = "(archived)";
    li.appendChild(arch);
  }

  // mousedown (not click) so this fires before the input's blur closes the list.
  li.addEventListener("mousedown", (e) => {
    e.preventDefault();
    selectResult(result, e.ctrlKey || e.metaKey);
  });
  li.addEventListener("mouseenter", () => setActiveIndex(index));

  return li;
}

function renderSearchResults() {
  const query = searchEl.value;
  searchResultsEl.replaceChildren();
  activeIndex = -1;

  if (!query.trim()) {
    closeSearchResults();
    return;
  }

  searchResults = searchLinks(query, state.links, state.collections);

  if (searchResults.length === 0) {
    const li = document.createElement("li");
    li.className = "search-empty muted";
    li.textContent = "No matches";
    // Not role="option" and no id: not selectable/openable, matches the
    // "don't fall back to a web search" contract (nothing to activate).
    searchResultsEl.appendChild(li);
  } else {
    searchResults.forEach((result, i) => searchResultsEl.appendChild(buildSearchResultRow(result, i)));
  }

  openSearchResults();
}

// Opens a result: records the same click op the rest of the app uses (so
// Frequent / click_count stay in sync), then navigates. Ctrl/Cmd+Enter (or
// ctrl/cmd-click) opens in a background tab and deliberately leaves the
// results open.
function selectResult(result, background) {
  if (!result) return;
  const { link } = result;
  applyOp({ type: "click", id: link.id, at: nowIso() });

  if (!isHttpUrl(link.url)) return; // never open a non-web address
  if (background) {
    try {
      chrome.tabs.create({ url: link.url, active: false });
    } catch {
      /* creating the background tab failed; keep the launcher usable */
    }
    return;
  }

  closeSearchResults();
  searchEl.value = "";
  location.href = link.url;
}

searchEl.addEventListener("input", renderSearchResults);

searchEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    if (searchResults.length === 0) return;
    e.preventDefault();
    setActiveIndex(activeIndex < searchResults.length - 1 ? activeIndex + 1 : 0);
  } else if (e.key === "ArrowUp") {
    if (searchResults.length === 0) return;
    e.preventDefault();
    setActiveIndex(activeIndex > 0 ? activeIndex - 1 : searchResults.length - 1);
  } else if (e.key === "Enter") {
    if (searchResults.length === 0) return; // nothing to open ("No matches" isn't selectable)
    e.preventDefault();
    selectResult(searchResults[activeIndex >= 0 ? activeIndex : 0], e.ctrlKey || e.metaKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    searchEl.value = "";
    closeSearchResults();
  }
});

// Typing anywhere on the page starts a search: the new-tab page autofocuses
// #search, but focus can wander (e.g. after a drag-and-drop). Only plain
// single printable, non-whitespace characters trigger this — modified keys,
// non-character keys (arrows, Tab, etc.), and keys destined for an
// interactive/editable control (inputs, buttons, links, menu items, the
// search results themselves) pass through untouched so e.g. Space/Enter on a
// focused button activates the button instead of stealing focus + typing a
// space into search.
const INTERACTIVE_SELECTOR =
  'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="option"]';
document.body.addEventListener("keydown", (e) => {
  const target = e.target;
  const isInteractive = target instanceof Element && target.closest(INTERACTIVE_SELECTOR);
  if (isInteractive || target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1 && e.key !== " ") searchEl.focus();
});

// ---------- archived toggle ----------

showArchivedBtn.addEventListener("click", () => {
  showArchived = !showArchived;
  showArchivedBtn.setAttribute("aria-pressed", String(showArchived));
  showArchivedBtn.textContent = showArchived ? "Hide archived" : "Archived";
  render();
});

init();
