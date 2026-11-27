// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
const get = (key, fallback) =>
  chrome.storage.local.get(key).then((o) => o[key] ?? fallback);
const set = (key, value) => chrome.storage.local.set({ [key]: value });

export const getConfig = () => get("config", { apiUrl: "", token: "" });
export const setConfig = (c) => set("config", c);
export const getState = () => get("state", { collections: [], links: [] });
export const setState = (s) => set("state", s);
export const getQueue = () => get("queue", []);
export const setQueue = (q) => set("queue", q);
