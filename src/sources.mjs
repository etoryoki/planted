// Where files come from: a working tree, the tips of every ref in a repository, or
// every blob in its history. Git objects are read with `git cat-file --batch`, so a
// branch is never checked out and nothing in it can run.
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isRelevant, isSecretFile } from "./rules.mjs";

const MAX_SIZE = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "out", ".turbo", ".cache", "coverage", "vendor"]);

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30 });
}

/** Files in a working tree (for local and CI checks). Yields { path, where, buf }. */
export function* worktreeFiles(root) {
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(r);
      } else if (e.isFile() && isRelevant(r)) {
        const full = path.join(root, r);
        if (statSync(full).size > MAX_SIZE) continue;
        yield { path: r, where: ["working tree"], buf: readFileSync(full) };
      }
    }
  }
}

/** All refs of a repository (branches, remote branches, tags, and any other namespace). */
export function listRefs(repo) {
  const out = git(repo, ["for-each-ref", "--format=%(objectname) %(objecttype) %(refname)"]).toString("utf8");
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "))
    .filter(([, type]) => type === "commit" || type === "tag")
    .map(([sha, , ref]) => ({ sha, ref }));
}

/**
 * Map blob id -> places it appears, over the tips of the given refs.
 * @returns {Map<string, { path: string, where: string[] }>}
 */
export function blobsAtRefs(repo, refs) {
  // many refs point at the same commit (a branch and its remote, merged branches): list each tree once
  const byCommit = new Map();
  for (const { sha, ref } of refs) {
    const short = ref.replace(/^refs\/(?:heads\/|remotes\/)?/, "");
    byCommit.set(sha, [...(byCommit.get(sha) ?? []), short]);
  }
  const blobs = new Map();
  for (const [commit, names] of byCommit) {
    let out;
    try {
      out = git(repo, ["ls-tree", "-r", "-z", "--full-tree", "-l", `${commit}^{tree}`]).toString("utf8");
    } catch {
      continue;
    }
    for (const entry of out.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, sha, size] = entry.slice(0, tab).split(/\s+/);
      const p = entry.slice(tab + 1);
      const secret = isSecretFile(p);
      if (type !== "blob" || (!secret && !isRelevant(p)) || Number(size) > MAX_SIZE) continue;
      const b = blobs.get(sha);
      if (b) {
        for (const n of names) if (!b.where.includes(n)) b.where.push(n);
      } else blobs.set(sha, { path: p, where: [...names], secret });
    }
  }
  return blobs;
}

/** Every relevant blob anywhere in history (reachable from any ref). */
export function blobsInHistory(repo) {
  const blobs = new Map();
  const out = git(repo, ["rev-list", "--objects", "--all"]).toString("utf8");
  const candidates = [];
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const p = line.slice(sp + 1);
    if (isRelevant(p) || isSecretFile(p)) candidates.push([line.slice(0, sp), p]);
  }
  for (const [sha, p] of candidates) if (!blobs.has(sha)) blobs.set(sha, { path: p, where: ["history"], secret: isSecretFile(p) });
  return blobs;
}

/**
 * Commits whose committer time zone is one the committer almost never uses and differs from
 * the author's. Rewritten (amended) commits keep the author but carry the rewriter's clock:
 * seen as -0700/-0800 in one campaign and +0200 in another, on commits whose dates were
 * forged to look months old. In refs mode only branch tips are judged (that is where
 * amended commits sit); the baseline always comes from the whole history.
 */
export function commitTimezoneAnomalies(repo, tipsOnly, { minCommits = 5, maxShare = 0.1 } = {}) {
  const rows = git(repo, ["log", "--all", "--format=%H%x09%ae%x09%ai%x09%ce%x09%ci%x09%at%x09%ct"])
    .toString("utf8").split("\n").filter(Boolean)
    .map((l) => {
      const [sha, ae, ai, ce, ci, at, ct] = l.split("\t");
      return { sha, ae, atz: ai.slice(-5), ce: ce.toLowerCase(), ctz: ci.slice(-5), date: ci.slice(0, 10), sameInstant: Math.abs(Number(ct) - Number(at)) <= 60 };
    });
  const tz = new Map(); // committer email -> Map(tz -> count)
  for (const r of rows) {
    const m = tz.get(r.ce) ?? new Map();
    m.set(r.ctz, (m.get(r.ctz) ?? 0) + 1);
    tz.set(r.ce, m);
  }
  let judged = rows;
  const refsAt = new Map();
  if (tipsOnly) {
    for (const { sha, ref } of listRefs(repo)) {
      const short = ref.replace(/^refs\/(?:heads\/|remotes\/)?/, "");
      refsAt.set(sha, [...(refsAt.get(sha) ?? []), short]);
    }
    judged = rows.filter((r) => refsAt.has(r.sha));
  }
  const out = [];
  for (const r of judged) {
    if (r.ctz === r.atz || /noreply@github\.com$/.test(r.ce)) continue;
    // baseline = this committer's other commits
    const m = tz.get(r.ce);
    const total = [...m.values()].reduce((a, b) => a + b, 0) - 1;
    const n = (m.get(r.ctz) ?? 0) - 1;
    if (total < minCommits || n / total > maxShare) continue;
    // A real squash, cherry-pick or rebase is committed later than it was authored. Forged
    // rewrites set the committer time to the author's instant (most seen samples), so only
    // that combination is medium; a rare zone on its own is info.
    out.push({
      rule: "commit-timezone",
      severity: r.sameInstant ? "medium" : "info",
      reason: `committed from ${r.ctz} (dated ${r.date})${r.sameInstant ? " at the exact author time" : ""}; this committer's other commits used ${r.ctz} ${n} of ${total} times, the author's zone is ${r.atz}`,
      path: `(commit ${r.sha.slice(0, 8)})`,
      where: tipsOnly ? refsAt.get(r.sha) : ["history"],
    });
  }
  return out;
}

/** Read blobs through one `git cat-file --batch` process. Yields { sha, buf }. */
export async function* readBlobs(repo, shas) {
  if (shas.length === 0) return;
  const proc = spawn("git", ["-C", repo, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "ignore"] });
  const writer = (async () => {
    for (const s of shas) if (!proc.stdin.write(s + "\n")) await new Promise((r) => proc.stdin.once("drain", r));
    proc.stdin.end();
  })();
  let buf = Buffer.alloc(0);
  let need = null; // { sha, size } while reading a body
  for await (const chunk of proc.stdout) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!need) {
        const nl = buf.indexOf(10);
        if (nl < 0) break;
        const [sha, type, size] = buf.subarray(0, nl).toString("latin1").split(" ");
        buf = buf.subarray(nl + 1);
        if (type === "missing" || size === undefined) continue;
        need = { sha, size: Number(size) };
      }
      if (buf.length < need.size + 1) break;
      const body = Buffer.from(buf.subarray(0, need.size));
      buf = buf.subarray(need.size + 1);
      yield { sha: need.sha, buf: body };
      need = null;
    }
  }
  await writer;
}
