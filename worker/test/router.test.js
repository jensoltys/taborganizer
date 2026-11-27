// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
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

  it("JSON answers are never cached", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    const res = await worker.fetch(new Request("https://x/api/state"), env);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
