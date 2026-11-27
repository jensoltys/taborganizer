// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
import { describe, it, expect } from "vitest";
import { sha256Hex, checkAuth } from "../src/auth.js";

const TOKEN = "test-token-abc";

function req(auth) {
  return new Request("https://x/api/state", { headers: auth ? { Authorization: auth } : {} });
}

describe("auth", () => {
  it("accepts the correct bearer token", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    expect(await checkAuth(req(`Bearer ${TOKEN}`), env)).toBe(true);
  });
  it("rejects a wrong token", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    expect(await checkAuth(req("Bearer nope"), env)).toBe(false);
  });
  it("rejects a missing header", async () => {
    const env = { API_TOKEN_HASH: await sha256Hex(TOKEN) };
    expect(await checkAuth(req(null), env)).toBe(false);
  });
});
