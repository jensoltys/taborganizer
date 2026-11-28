#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
// Makes a new access token for your Tab Organizer Worker.
// Prints the token (paste it into the extension's Options page) and its SHA-256 hash
// (store it on the Worker with: npx wrangler secret put API_TOKEN_HASH).
// The Worker only ever keeps the hash, so save the token in your password manager.
//
// Run: node scripts/make-token.mjs
import { webcrypto as crypto } from "node:crypto";

const bytes = crypto.getRandomValues(new Uint8Array(32));
const token = Buffer.from(bytes).toString("base64url");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

console.log("Token (goes in the extension's Options page, keep it secret):");
console.log("  " + token);
console.log("");
console.log("Hash (goes on the Worker as API_TOKEN_HASH):");
console.log("  " + hash);
