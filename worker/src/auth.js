// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the Tab Organizer authors. See LICENSE.
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare of two equal-length hex strings.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkAuth(request, env) {
  // Self-host guard: no API_TOKEN_HASH (or a typo in it) means nobody gets in.
  if (!/^[0-9a-f]{64}$/.test(env.API_TOKEN_HASH || "")) return false;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  const hash = await sha256Hex(header.slice(7));
  return timingSafeEqual(hash, env.API_TOKEN_HASH || "");
}
