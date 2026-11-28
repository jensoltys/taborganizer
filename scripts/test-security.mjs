#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Jen Soltys. See LICENSE.
// Security regression gate for tab-organizer (Worker + D1 backend, MV3 extension).
//
// The point of this gate: every time a security audit surfaces a new finding,
// add one check here so the same thing can't silently regress in a future
// change. See SECURITY.md for how to report a problem.
//
// Run: node scripts/test-security.mjs
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === ".wrangler" || entry === "dist" || entry === "build") continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      listFiles(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function flag(severity, file, line, rule, detail) {
  findings.push({ severity, file: file ? relative(repoRoot, file) : "(repo)", line, rule, detail });
}

// ── 1. Tracked secret files ────────────────────────────────────────────────
// worker/.dev.vars holds API_TOKEN_HASH, and a TOKEN.txt would hold a raw token.
// Neither should ever be tracked by git.
let trackedFiles = [];
try {
  trackedFiles = execSync("git ls-files", { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  // Not a git repo (or git unavailable) — skip the tracked-file check but keep scanning source.
  trackedFiles = null;
}

if (trackedFiles) {
  for (const f of trackedFiles) {
    if (/(^|\/)\.dev\.vars$/.test(f) || /(^|\/)TOKEN\.txt$/i.test(f)) {
      flag("HIGH", f, 0, "secret file tracked by git", "Untrack immediately (git rm --cached) and rotate the token — it may be exposed in history.");
    }
  }
}

// ── 2. Hardcoded secret patterns in tracked source ─────────────────────────
const secretPatterns = [
  { re: /sk-ant-api03-[A-Za-z0-9_-]{20,}/, rule: "hardcoded ANTHROPIC key" },
  { re: /\bre_[A-Za-z0-9]{20,}/, rule: "hardcoded RESEND key" },
  { re: /sk_live_[A-Za-z0-9]{20,}/, rule: "hardcoded STRIPE live key" },
  { re: /ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, rule: "hardcoded GitHub PAT" },
  { re: /xox[baprs]-[A-Za-z0-9-]{20,}/, rule: "hardcoded Slack token" },
  { re: /AIza[A-Za-z0-9_-]{30,}/, rule: "hardcoded Google API key" },
  { re: /\b[0-9a-f]{64}\b/i, rule: "raw 64-hex secret (e.g. API_TOKEN_HASH)" },
];

const sourceFiles = trackedFiles
  ? trackedFiles.filter((f) => /\.(js|mjs|ts|json|toml|sql|md|yml|yaml|html|example)$/.test(f) && !/package-lock\.json$/.test(f))
  : [
      ...listFiles(join(repoRoot, "worker", "src"), [".js", ".mjs"]),
      ...listFiles(join(repoRoot, "extension"), [".js", ".mjs"]),
    ];

for (const rel of sourceFiles) {
  const full = trackedFiles ? join(repoRoot, rel) : rel;
  if (!existsSync(full) || statSync(full).isDirectory()) continue;
  const content = readFileSync(full, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    for (const { re, rule } of secretPatterns) {
      if (re.test(line)) {
        flag("HIGH", full, idx + 1, rule, "Move to a wrangler secret / gitignored file, never commit.");
      }
    }
  });
}

// ── 3. XSS sinks anywhere in extension/ ────────────────────────────────────
// Link titles / collection names / tab titles come from untrusted web pages
// and reach the DOM. Every render path must use textContent/createElement,
// never HTML-string building.
const extDir = join(repoRoot, "extension");
const extFiles = listFiles(extDir, [".js", ".mjs", ".html"]);
const xssSinkRe = /(\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(|dangerouslySetInnerHTML)/;

for (const f of extFiles) {
  const content = readFileSync(f, "utf8");
  content.split("\n").forEach((line, idx) => {
    if (xssSinkRe.test(line)) {
      flag("HIGH", f, idx + 1, "XSS sink in extension", "Untrusted page titles/URLs must reach the DOM via textContent/element properties only — no HTML-string sinks anywhere in extension/.");
    }
  });
}

// ── 4. Permissive CORS in worker source ────────────────────────────────────
const workerSrcDir = join(repoRoot, "worker", "src");
const workerFiles = listFiles(workerSrcDir, [".js", ".mjs"]);
for (const f of workerFiles) {
  const content = readFileSync(f, "utf8");
  content.split("\n").forEach((line, idx) => {
    if (/Access-Control-Allow-Origin['"\s:,]+\*/.test(line)) {
      flag("HIGH", f, idx + 1, "CORS wildcard", "This app needs no CORS headers at all (extension uses host_permissions). A wildcard origin here is a regression.");
    }
  });
}

// ── 5. SQL string interpolation in worker/src ──────────────────────────────
// Every query must use .bind(...) params. Flag template-literal or +
// concatenation feeding a SQL-shaped string.
for (const f of workerFiles) {
  const content = readFileSync(f, "utf8");
  const lines = content.split("\n");
  lines.forEach((line, idx) => {
    const sqlKeyword = /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(line);
    if (!sqlKeyword) return;
    const templateInterp = /`[^`]*\$\{[^}]+\}[^`]*`/.test(line);
    const concatInterp = /['"`]\s*\+\s*[A-Za-z_$]|[A-Za-z_$][\w.]*\s*\+\s*['"`]/.test(line);
    if (templateInterp || concatInterp) {
      flag("HIGH", f, idx + 1, "possible SQL interpolation", "Use .bind() positional params — never template-literal/+ concatenation of variables into SQL.");
    }
    // SELECT * — warn only (fixed two-table schema, every column is the app's own).
    if (/\bSELECT\s+\*/i.test(line)) {
      flag("LOW", f, idx + 1, "SELECT *", "Enumerate columns explicitly if the schema grows to include non-public fields.");
    }
  });
}

// ── 5b. Saved addresses only open when they're web addresses ───────────────
// A saved link's address can come back from the Worker or a drop. Every place that opens
// one (location.href, chrome.tabs.create, a.href) must sit behind isHttpUrl().
{
  const nt = join(extDir, "newtab", "newtab.js");
  if (existsSync(nt)) {
    const lines = readFileSync(nt, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!/(location\.href\s*=|\.href\s*=|tabs\.create\s*\()\s*.*link\.url/.test(line)) return;
      const near = lines.slice(Math.max(0, idx - 14), idx + 1).join("\n");
      if (!/isHttpUrl\(link\.url\)/.test(near)) {
        flag("HIGH", nt, idx + 1, "saved address opened without isHttpUrl()", "Guard this line with isHttpUrl(link.url) so only http(s) addresses are ever opened.");
      }
    });
  }
}

// ── 6. Manifest host_permissions / permissions least-privilege ─────────────
const manifestPath = join(repoRoot, "extension", "manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // optional_host_permissions may be broad (the user grants one origin at a time);
  // host_permissions are granted at install, so they must stay narrow.
  const hostPerms = manifest.host_permissions || [];
  for (const perm of hostPerms) {
    if (/^\s*<all_urls>\s*$/.test(perm) || /^\*:\/\/\*\/\*$/.test(perm) || perm === "*://*/*") {
      flag("HIGH", manifestPath, 0, "overly broad host_permissions", `Found '${perm}' — scope to the specific worker origin instead.`);
    }
  }
  if (manifest.manifest_version !== 3) {
    flag("HIGH", manifestPath, 0, "not MV3", "manifest_version must be 3.");
  }
}

// ── 7. npm audit (informational — warn only) ───────────────────────────────
function npmAuditSummary(dir) {
  if (!existsSync(join(repoRoot, dir, "package.json"))) return null;
  try {
    const out = execSync("npm audit --omit=dev --json", { cwd: join(repoRoot, dir), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const parsed = JSON.parse(out);
    const meta = parsed.metadata?.vulnerabilities || {};
    const high = (meta.high || 0) + (meta.critical || 0);
    return { high, total: Object.values(meta).reduce((a, b) => a + b, 0) };
  } catch (e) {
    // npm audit exits non-zero when vulnerabilities are found; stdout still has JSON.
    try {
      const parsed = JSON.parse(e.stdout || "{}");
      const meta = parsed.metadata?.vulnerabilities || {};
      const high = (meta.high || 0) + (meta.critical || 0);
      return { high, total: Object.values(meta).reduce((a, b) => a + b, 0) };
    } catch {
      return null;
    }
  }
}

for (const dir of ["worker", "extension"]) {
  const result = npmAuditSummary(dir);
  if (result && result.high > 0) {
    flag("MEDIUM", join(repoRoot, dir, "package.json"), 0, "npm audit high/critical", `${result.high} high/critical (of ${result.total} total) in ${dir}/ — these are dev-tool deps (wrangler/vitest), triage before treating as urgent.`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
const high = findings.filter((f) => f.severity === "HIGH");
const med = findings.filter((f) => f.severity === "MEDIUM");
const low = findings.filter((f) => f.severity === "LOW");

if (findings.length === 0) {
  console.log("PASS — security regression gate: no findings.");
  process.exit(0);
}

console.log(`security scan: ${high.length} HIGH, ${med.length} MEDIUM, ${low.length} LOW`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.log(`  [${f.severity}] ${where}  '${f.rule}' — ${f.detail}`);
}

if (high.length > 0) {
  console.log(`\nFAIL — ${high.length} HIGH finding(s). Fix these before you deploy.`);
  process.exit(1);
}

console.log("\nPASS (with warnings) — no HIGH findings; MEDIUM/LOW above are informational.");
process.exit(0);
