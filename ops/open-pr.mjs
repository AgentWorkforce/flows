#!/usr/bin/env node
// Open a PR from a cloud sandbox, which has no git remote and no GitHub token.
//
// Cloud deliberately keeps raw GitHub tokens out of workflow sandboxes (see
// WORKFLOW_GITHUB_WRITE_GRANTS: every entry sets envTokenNames: []). Delivery
// therefore goes through the server-side proxy at
// POST {CLOUD_API_URL}/api/v1/github/pull-request, which takes file CONTENTS
// rather than a git push, authenticated with the sandbox's RELAYFILE_TOKEN.
//
// Every failure here is typed and says which precondition was missing. A step
// that cannot deliver must say so in one line, not die on an opaque error
// after five expensive steps.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const MAX_FILE_BYTES = 1_000_000;

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf-8" }).trim();
}

function fail(code, message, detail) {
  console.error(`${code}: ${message}`);
  if (detail) console.error(detail);
  process.exit(75);
}

const apiUrl = (process.env.CLOUD_API_URL ?? "").replace(/\/$/, "");
const token = process.env.RELAYFILE_TOKEN ?? "";
const owner = process.env.FLOWS_PR_OWNER ?? "AgentWorkforce";
const repo = process.env.FLOWS_PR_REPO ?? "flows";

if (!apiUrl) fail("PR_BLOCKED_NO_API_URL", "CLOUD_API_URL is not set in this environment.");
if (!token) fail("PR_BLOCKED_NO_RELAYFILE_TOKEN", "RELAYFILE_TOKEN is not set; the proxy cannot authenticate this sandbox.");

const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch === "HEAD") fail("PR_BLOCKED_DETACHED_HEAD", "Refusing to open a PR from a detached HEAD.");

// The snapshot base: sync commits the uploaded tree as `main`, so `main..HEAD`
// is exactly this tick's work.
let baseSha;
try {
  baseSha = sh("git", ["rev-parse", "main"]);
} catch {
  fail("PR_BLOCKED_NO_BASE", "No `main` ref in this sandbox, so there is nothing to diff against.");
}

const changed = sh("git", ["diff", "--name-only", "main...HEAD"])
  .split("\n").map((l) => l.trim()).filter(Boolean);

if (changed.length === 0) {
  console.log("PR_SKIPPED_NO_CHANGES: this tick produced no diff against main.");
  process.exit(0);
}

const files = [];
const skipped = [];
for (const path of changed) {
  let st;
  try {
    st = statSync(path);
  } catch {
    skipped.push(`${path} (deleted — the proxy takes contents, not deletions)`);
    continue;
  }
  if (st.size > MAX_FILE_BYTES) {
    skipped.push(`${path} (${st.size} bytes exceeds ${MAX_FILE_BYTES})`);
    continue;
  }
  const buf = readFileSync(path);
  // Send text as utf-8 and anything else base64, matching the endpoint's
  // `encoding` field.
  const isText = !buf.includes(0);
  files.push({
    path,
    content: isText ? buf.toString("utf-8") : buf.toString("base64"),
    encoding: isText ? "utf-8" : "base64",
  });
}

if (skipped.length > 0) {
  // Never let a silent drop look like a complete delivery.
  console.error(`PR_PARTIAL_WARNING: ${skipped.length} changed path(s) were not sent:`);
  for (const s of skipped) console.error(`  - ${s}`);
}
if (files.length === 0) {
  fail("PR_BLOCKED_NOTHING_SENDABLE", "Every changed path was skipped; refusing to open an empty PR.");
}

let title = "drive: work package";
try {
  const next = readFileSync("ops/NEXT.md", "utf-8");
  const m = next.match(/WP-\d+[^\n|]*/);
  if (m) title = `drive: ${m[0].trim()}`;
} catch { /* ops/NEXT.md is optional here */ }

const payload = {
  owner, repo, branch, baseSha, baseBranch: "main", title,
  body: [
    "Automated drive tick from a cloud sandbox.",
    "",
    `Work package: see \`ops/NEXT.md\` in the diff.`,
    "Verification and adversarial review ran in-run; see `ops/reviews/` in the diff.",
    "",
    "A human merges.",
  ].join("\n"),
  files,
  author: { name: "Relayflow Lead", email: "lead@relayflows.local" },
};

const res = await fetch(`${apiUrl}/api/v1/github/pull-request`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  // Name the two failures we expect, so they are not mistaken for outages.
  if (res.status === 403) {
    fail("PR_BLOCKED_FORBIDDEN",
      `The proxy refused this sandbox (HTTP 403). Two preconditions must BOTH hold: an entry for ${owner}/${repo} in WORKFLOW_GITHUB_WRITE_GRANTS, and a deployed persona whose deployedName equals that grant's slug.`,
      text.slice(0, 500));
  }
  if (res.status === 401) {
    fail("PR_BLOCKED_UNAUTHORIZED", "The proxy rejected RELAYFILE_TOKEN (HTTP 401).", text.slice(0, 500));
  }
  fail("PR_FAILED_HTTP", `The proxy returned HTTP ${res.status}.`, text.slice(0, 500));
}

let parsed;
try { parsed = JSON.parse(text); } catch { parsed = null; }
console.log(`PR_OPENED: ${parsed?.pullRequestUrl ?? parsed?.url ?? text.slice(0, 200)}`);
