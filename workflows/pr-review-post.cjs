#!/usr/bin/env node
// pr-review-post — publish flows-pr-review's verdict as ONE comment per PR.
//
// Used by workflows/pr-review.flow.ts (which embeds this file verbatim and
// writes it into the run's scratch dir; packages/sdk/tests/pr-review-post.test.ts
// keeps the two in sync and exercises every branch against a fake GitHub).
//
//   node pr-review-post.cjs <owner> <repo> <pr-number> <head-sha> <body-file>
//   env: GH_TOKEN (required), GITHUB_API (default https://api.github.com)
//
// Ownership: a marker "<!-- flows-pr-review <sha> by:<login> -->" is ours only
// when the comment's author IS that login — anyone can type the marker,
// nobody else can post as our identity. Legacy markers without "by:" (from
// the previously deployed copy) are adopted when authored by the same login
// as a comment we own, or by the login we just posted as.
//
// Ordering: a verdict for an older head never overwrites a newer one. GitHub's
// compare API decides (ahead/identical → theirs stays; behind → ours wins;
// diverged, i.e. rebase → the more recently committed head wins). A head the
// repo can no longer resolve loses.
//
// Delivery: only the POST/PATCH that carries the verdict is fatal. Cleanup,
// compare and re-read calls are best-effort and log instead of failing.

const [owner, repo, number, headSha, bodyPath] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!owner || !repo || !number || !headSha || !bodyPath) { console.error("usage: pr-review-post.cjs <owner> <repo> <number> <headSha> <bodyFile>"); process.exit(2); }
if (!token) { console.error("GH_TOKEN is not set; cannot post the review"); process.exit(1); }
const fs = require("fs");
const API = (process.env.GITHUB_API || "https://api.github.com") + "/repos/" + owner + "/" + repo;
const MARK = "<!-- flows-pr-review";
const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "flows-pr-review" };

async function gh(method, url, body, opts) {
  const soft = opts && opts.soft;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    if (soft) { console.log("soft-fail " + method + " " + url + ": " + (error && error.message)); return null; }
    console.error(method + " " + url + " failed: " + (error && error.message)); process.exit(1);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    if (soft) { console.log("soft-fail " + method + " " + url + " -> " + res.status + " " + text); return null; }
    console.error(method + " " + url + " -> " + res.status + " " + text); process.exit(1);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const markerFor = (login) => MARK + " " + headSha + " by:" + login + " -->";
/** {sha, login|null} for any marker line (new or legacy form), else null. */
function readMark(c) {
  if (!c || typeof c.body !== "string" || !c.user) return null;
  const m = c.body.match(/^<!-- flows-pr-review ([0-9a-f]{40})(?: by:(\S+))? -->/);
  return m ? { sha: m[1], login: m[2] || null } : null;
}
/** Marker comments that are provably ours; `knownLogins` adopts legacy/pending markers by author. */
async function ours(knownLogins) {
  const all = [];
  for (let page = 1; page <= 50; page += 1) {
    const list = await gh("GET", API + "/issues/" + number + "/comments?per_page=100&page=" + page);
    for (const c of list) { const m = readMark(c); if (m) all.push({ c, m }); }
    if (list.length < 100) break;
    if (page === 50) { console.error("more than 5000 comments; refusing to post without a complete scan"); process.exit(1); }
  }
  const logins = new Set(knownLogins || []);
  for (const x of all) if (x.m.login && x.m.login !== "pending" && x.c.user.login === x.m.login) logins.add(x.m.login);
  return all.filter((x) => (x.m.login && x.m.login !== "pending") ? x.c.user.login === x.m.login : logins.has(x.c.user.login));
}
async function committerDate(sha) { const c = await gh("GET", API + "/commits/" + sha, undefined, { soft: true }); return c ? Date.parse(c.commit.committer.date) : null; }
/** Should the comment carrying `theirSha` stay as it is (i.e. is it not older than ours)? */
async function theirsWins(theirSha) {
  if (theirSha === headSha) return true;
  const cmp = await gh("GET", API + "/compare/" + headSha + "..." + theirSha, undefined, { soft: true });
  if (!cmp) return false; // a head the repo cannot resolve is not a newer head
  if (cmp.status === "ahead" || cmp.status === "identical") return true;
  if (cmp.status === "behind") return false;
  const [theirs, mine] = [await committerDate(theirSha), await committerDate(headSha)];
  if (theirs === null || mine === null) return false;
  return theirs >= mine;
}
const byPreference = (a, b) => (a.m.sha === headSha ? -1 : b.m.sha === headSha ? 1 : Date.parse(b.c.updated_at) - Date.parse(a.c.updated_at));
async function softDelete(id) { await gh("DELETE", API + "/issues/comments/" + id, undefined, { soft: true }); console.log("deleted duplicate comment " + id); }

(async () => {
  let text = fs.readFileSync(bodyPath, "utf8");
  if (Buffer.byteLength(text) > 60000) text = Buffer.from(text).subarray(0, 60000).toString() + "\n\n_…truncated; the full review is in the run artifacts._\n";

  // Identity first when the token allows (a user token does; an installation
  // token may 403): it lets legacy markers be adopted on the first scan and
  // makes the create path a single write.
  const me = await gh("GET", (process.env.GITHUB_API || "https://api.github.com") + "/user", undefined, { soft: true });
  let found = await ours(me && me.login ? [me.login] : []);
  if (found.length > 1) {
    // Converge legacy duplicates to one comment without discarding a newer
    // verdict: keep the one for our SHA, else the most recently updated.
    found.sort(byPreference);
    for (const dup of found.slice(1)) await softDelete(dup.c.id);
    found = [found[0]];
  }
  const existing = found[0];

  if (!existing) {
    const posted = await gh("POST", API + "/issues/" + number + "/comments", { body: markerFor(me && me.login ? me.login : "pending") + "\n" + text });
    const login = posted.user.login;
    if (!(me && me.login)) await gh("PATCH", API + "/issues/comments/" + posted.id, { body: markerFor(login) + "\n" + text }, { soft: true });
    // Two wakes can both scan-then-create. Re-scan (adopting any by:pending
    // orphans this login left) and converge on the comment whose head wins.
    const again = (await ours([login])).filter((x) => x.c.user.login === login);
    if (again.length > 1) {
      let keep = again.find((x) => x.c.id === posted.id) || again[0];
      for (const other of again) {
        if (other.c.id === keep.c.id) continue;
        if (other.m.sha === headSha) { if (other.c.id < keep.c.id) keep = other; }   // same head: lowest id wins
        else if (await theirsWins(other.m.sha)) keep = other;                         // a newer head owns the comment
      }
      for (const other of again) if (other.c.id !== keep.c.id) await softDelete(other.c.id);
      if (keep.c.id !== posted.id) { console.log("raced: kept " + keep.c.id + " (" + keep.m.sha.slice(0, 8) + "), deleted ours " + posted.id); return; }
    }
    console.log("posted comment " + posted.id + " for " + headSha); return;
  }

  // Re-read right before writing; a vanished comment means "none exists".
  const fresh = await gh("GET", API + "/issues/comments/" + existing.c.id, undefined, { soft: true });
  if (fresh === null) {
    const posted = await gh("POST", API + "/issues/" + number + "/comments", { body: markerFor(existing.m.login || existing.c.user.login) + "\n" + text });
    console.log("re-posted comment " + posted.id + " for " + headSha + " (previous one vanished)"); return;
  }
  const cur = readMark(fresh);
  if (cur && (await theirsWins(cur.sha))) { console.log("comment already carries " + cur.sha + "; not overwriting with " + headSha); return; }
  await gh("PATCH", API + "/issues/comments/" + existing.c.id, { body: markerFor(existing.m.login || existing.c.user.login) + "\n" + text });
  console.log("updated comment " + existing.c.id + " for " + headSha);
})();
