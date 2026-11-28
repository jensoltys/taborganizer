// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { checkAuth } from "./auth.js";
import { getState, applyOps } from "./sync.js";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const TOO_LARGE = Symbol("too large");

// Reads the body in pieces and stops at the cap, so an oversized body is never held in
// memory whole (a chunked upload has no Content-Length to refuse up front).
// Answers the parsed JSON, TOO_LARGE, or null for anything that isn't JSON.
async function readJson(request) {
  let text;
  try {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const parts = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { try { await reader.cancel(); } catch { /* already closed */ } return TOO_LARGE; }
      parts.push(value);
    }
    const all = new Uint8Array(total); let at = 0;
    for (const part of parts) { all.set(part, at); at += part.byteLength; }
    text = new TextDecoder().decode(all);
  } catch { return null; }
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");

    if (!(await checkAuth(request, env)))
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });

    if (request.method === "GET" && url.pathname === "/api/state") {
      try { return new Response(JSON.stringify(await getState(env.DB)), { headers: JSON_HEADERS }); }
      catch (err) {
        console.error("state failed", err);
        return new Response(JSON.stringify({ error: "storage error, try again" }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (request.method === "POST" && url.pathname === "/api/sync") {
      // Largest honest batch is far under this. Refuse oversized bodies before reading them.
      if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES)
        return new Response(JSON.stringify({ error: "too large" }), { status: 413, headers: JSON_HEADERS });
      const body = await readJson(request);
      if (body === TOO_LARGE) return new Response(JSON.stringify({ error: "too large" }), { status: 413, headers: JSON_HEADERS });
      if (body === null) return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: JSON_HEADERS });
      if (!Array.isArray(body?.ops) || body.ops.length > 500)
        return new Response(JSON.stringify({ error: "ops must be an array of <=500" }), { status: 400, headers: JSON_HEADERS });
      let result;
      try { result = await applyOps(env.DB, body.ops); }
      catch (err) {
        console.error("sync failed", err);
        return new Response(JSON.stringify({ error: "storage error, try again" }), { status: 500, headers: JSON_HEADERS });
      }
      return new Response(JSON.stringify(result), { headers: JSON_HEADERS });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: JSON_HEADERS });
  },
};
