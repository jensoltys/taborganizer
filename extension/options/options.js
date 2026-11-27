// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
import { getConfig, setConfig } from "../lib/store.js";

const $ = (id) => document.getElementById(id);

// Fill in what's saved, unless something was already typed while this loaded.
getConfig().then((c) => {
  if (!$("apiUrl").value) $("apiUrl").value = c.apiUrl;
  if (!$("token").value) $("token").value = c.token;
});

// https only, except a local `wrangler dev` on localhost / 127.0.0.1.
function cleanUrl(raw) {
  const v = raw.trim().replace(/\/$/, "");
  if (!v) return "";
  const u = new URL(v);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("use an https:// address");
  return u.origin;
}

// The extension ships with no site access. This asks Chrome for access to the one
// Worker address typed in, so the extension can't reach any other site.
// It must run straight from the click (Chrome only shows the prompt on a user action).
function askAccess(origin) {
  if (!origin) return Promise.resolve(true);
  return chrome.permissions.request({ origins: [origin + "/*"] });
}

$("save").onclick = async () => {
  let apiUrl;
  try { apiUrl = cleanUrl($("apiUrl").value); } catch (e) { $("status").textContent = `Not saved: ${e.message}`; return; }
  const granted = await askAccess(apiUrl);
  if (!granted) { $("status").textContent = "Not saved: Chrome access to that address was declined."; return; }
  const before = (await getConfig()).apiUrl;
  await setConfig({ apiUrl, token: $("token").value.trim() });
  // Changed or cleared the address: hand back Chrome's access to the old one.
  // (Chrome grants access per host, not per port, so a port-only change keeps it.)
  const host = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
  if (before && host(before) !== host(apiUrl)) {
    try { await chrome.permissions.remove({ origins: [before + "/*"] }); } catch { /* already gone */ }
  }
  $("status").textContent = apiUrl ? "Saved." : "Saved. Links stay in this browser only.";
};

$("test").onclick = async () => {
  let apiUrl;
  try { apiUrl = cleanUrl($("apiUrl").value); } catch (e) { $("status").textContent = `Failed: ${e.message}`; return; }
  if (!apiUrl) { $("status").textContent = "Add your Worker address first."; return; }
  if (!(await askAccess(apiUrl))) { $("status").textContent = "Failed: Chrome access to that address was declined."; return; }
  try {
    const r = await fetch(`${apiUrl}/api/state`, { headers: { Authorization: `Bearer ${$("token").value.trim()}` } });
    $("status").textContent = r.ok ? "Connected." : `Failed: HTTP ${r.status}`;
  } catch (e) { $("status").textContent = `Failed: ${e.message}`; }
};
