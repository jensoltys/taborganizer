// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
import { describe, it, expect } from "vitest";
import worker from "../src/index.js";
import { sha256Hex } from "../src/auth.js";

const TOKEN = "test-token-abc";

describe("router", () => {
  it("GET /health with no auth returns 200 ok (health passthrough)", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(new Request("https://x/health"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("POST /health with no auth returns 401 (method-scoped health check)", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(new Request("https://x/health", { method: "POST" }), env);
    expect(res.status).toBe(401);
  });

  it("GET /api/state with no auth returns 401 (protected route rejects)", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(new Request("https://x/api/state"), env);
    expect(res.status).toBe(401);
  });

  it("GET /some-unknown-path with valid auth returns 404 (auth passes, no route matches)", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(
      new Request("https://x/some-unknown-path", { headers: { Authorization: `Bearer ${TOKEN}` } }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("POST /api/sync answers 500 (not 200) when the database fails, and 413 for an oversized body", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN), DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: boom"); } }) }) } };
    const T = "2026-07-10T10:00:00.000Z";
    const post = (body, extra = {}) => worker.fetch(new Request("https://x/api/sync", { method: "POST", body, headers: { Authorization: `Bearer ${TOKEN}`, ...extra } }), env);
    const res = await post(JSON.stringify({ ops: [{ type: "upsert_collection", row: { id: "c1", name: "A", sort_order: 1, archived: 0, created_at: T, updated_at: T } }] }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("boom");
    expect((await post("{}", { "Content-Length": String(3 * 1024 * 1024) })).status).toBe(413);
  });

  it("POST /api/sync answers 413 for an oversized body sent with no Content-Length (chunked)", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN), DB: { prepare: () => { throw new Error("should never reach the database"); } } };
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"ops":[],"pad":"')); },
      pull(c) {
        if (sent >= 3 * 1024 * 1024) { c.enqueue(new TextEncoder().encode('"}')); c.close(); return; }
        c.enqueue(chunk); sent += chunk.byteLength;
      },
    });
    const req = new Request("https://x/api/sync", { method: "POST", body, headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(req.headers.get("Content-Length")).toBeNull();
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(3 * 1024 * 1024); // stopped reading at the cap
  });

  it("POST /api/sync still takes a normal streamed body and refuses one that isn't JSON", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN), DB: { prepare: () => { throw new Error("no ops, no queries"); } } };
    const post = (text) => worker.fetch(new Request("https://x/api/sync", { method: "POST", body: new Blob([text]).stream(), headers: { Authorization: `Bearer ${TOKEN}` } }), env);
    const ok = await post('{"ops":[]}');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ applied: 0, skipped: 0 });
    expect((await post("not json")).status).toBe(400);
  });

  it("JSON answers are never cached", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(new Request("https://x/api/state"), env);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
