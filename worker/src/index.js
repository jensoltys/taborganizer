// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
import { checkAuth } from "./auth.js";
import { getState, applyOps } from "./sync.js";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers: JSON_HEADERS }); }
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
