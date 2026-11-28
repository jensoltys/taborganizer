// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
export const uuid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();
export const faviconUrl = (pageUrl, size = 32) =>
  chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`);
