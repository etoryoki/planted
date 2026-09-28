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
  // many refs point at the same commit (a branch and its remote, merged branches): one entry each
  const byCommit = new Map();
  for (const { sha, ref } of refs) {
    const short = ref.replace(/^refs\/(?:heads\/|remotes\/)?/, "");
    byCommit.set(sha, [...(byCommit.get(sha) ?? []), short]);
  }
  const blobs = new Map();
  const add = (sha, p, names) => {
    const secret = isSecretFile(p);
    if (!secret && !isRelevant(p)) return;
    const b = blobs.get(sha);
    if (b) {
      for (const n of names) if (!b.where.includes(n)) b.where.push(n);
    } else blobs.set(sha, { path: p, where: [...names], secret });
  };

  // List one tree in full (the default branch), and for every other tip only what differs
  // from it. Hundreds of PR refs share most files with the default branch; listing each tree
  // in full made a repository with ~800 PR refs take minutes.
  let base = null;
  try {
    base = git(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]).toString().trim();
  } catch {}
  if (!base || !byCommit.has(base)) base = byCommit.keys().next().value ?? null;
  if (!base) return blobs;

  const baseNames = byCommit.get(base);
  const baseFiles = new Map(); // path -> blob, for attributing unchanged files to other refs
  for (const entry of git(repo, ["ls-tree", "-r", "-z", "--full-tree", "-l", `${base}^{tree}`]).toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [, type, sha, size] = entry.slice(0, tab).split(/\s+/);
    const p = entry.slice(tab + 1);
    if (type !== "blob" || Number(size) > MAX_SIZE) continue;
    baseFiles.set(p, sha);
    add(sha, p, baseNames);
  }

  // every other tip against the base, through one `git diff-tree --stdin` (a process per ref
  // is slow with thousands of PR refs, especially on Windows)
  const others = [...byCommit.keys()].filter((c) => c !== base);
  const trees = execFileSync("git", ["-C", repo, "cat-file", "--batch-check=%(objectname)"], {
    input: [base, ...others].map((c) => `${c}^{tree}`).join("\n") + "\n",
    maxBuffer: 1 << 30,
  }).toString("utf8").split("\n");
  const baseTree = trees[0];
  const namesByTree = new Map(); // tree -> ref names (commits can share a tree)
  const changedBy = new Map(); // tree -> { names, changed paths }
  others.forEach((c, i) => {
    const t = trees[i + 1];
    if (!/^[0-9a-f]{40,64}$/.test(t ?? "")) return;
    namesByTree.set(t, [...(namesByTree.get(t) ?? []), ...byCommit.get(c)]);
  });
  for (const [t, names] of namesByTree) changedBy.set(t, { names, changed: new Set() });
  const pairs = [...namesByTree.keys()].filter((t) => t !== baseTree);
  if (pairs.length) {
    const out = execFileSync("git", ["-C", repo, "diff-tree", "--stdin", "-r", "-z", "--no-renames"], {
      input: pairs.map((t) => `${baseTree} ${t}`).join("\n") + "\n",
      maxBuffer: 1 << 30,
    }).toString("utf8");
    let cur = null;
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i++) {
      let tok = parts[i];
      // each pair starts with "<tree> <tree>\n", run together with its first entry
      const header = /^\n?([0-9a-f]{40,64}) ([0-9a-f]{40,64})\n/.exec(tok);
      if (header) {
        cur = changedBy.get(header[2]);
        tok = tok.slice(header[0].length);
      }
      if (!tok.startsWith(":") || !cur) continue;
      const p = parts[++i];
      cur.changed.add(p);
      const [, newMode, , newSha, status] = tok.slice(1).split(" ");
      if (status === "D" || newMode.startsWith("16")) continue; // deleted, or a submodule
      add(newSha, p, cur.names);
    }
  }

  // a file a ref did not touch is the base's file: it is in that ref too
  for (const [p, sha] of baseFiles) {
    const b = blobs.get(sha);
    if (!b || b.path !== p) continue;
    for (const { names, changed } of changedBy.values()) {
      if (!changed.has(p)) for (const n of names) if (!b.where.includes(n)) b.where.push(n);
    }
  }
  if (blobs.size) dropLarge(repo, blobs);
  return blobs;
}

/** Diff output has no sizes: ask git once and drop what is too large to read. */
function dropLarge(repo, blobs) {
  const out = execFileSync("git", ["-C", repo, "cat-file", "--batch-check=%(objectname) %(objectsize)"], {
    input: [...blobs.keys()].join("\n") + "\n",
    maxBuffer: 1 << 30,
  }).toString("utf8");
  for (const line of out.split("\n")) {
    const [sha, size] = line.split(" ");
    if (size !== undefined && Number(size) > MAX_SIZE) blobs.delete(sha);
  }
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
