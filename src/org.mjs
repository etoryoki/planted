// Check every repository of a GitHub organization from one place.
//
// A per-repository CI job misses repositories without CI, and an attacker with write access
// can delete it. This runs outside the repositories: mirror-clone each one (all branches and
// PR refs), read every tip, and report what is new against a per-repository baseline.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { applyBaseline, loadBaseline, writeBaseline } from "./baseline.mjs";
import { scan } from "./scan.mjs";

const TOKEN = () => process.env.PLANTED_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

/**
 * Git sees the token through config in the environment (as actions/checkout does), never in
 * a URL or on a command line, where logs and process lists would show it. Without a token,
 * git's own credential helper is used.
 */
function gitEnv() {
  const token = TOKEN();
  if (!token) return process.env;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

/** Repositories of an organization: via the API with a token, or via `gh` when logged in. */
export async function listOrgRepos(org, { includeArchived = true } = {}) {
  let repos = [];
  const token = TOKEN();
  if (token) {
    for (let page = 1; ; page++) {
      const res = await fetch(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "planted" },
      });
      if (!res.ok) throw new Error(`listing ${org}: GitHub API ${res.status}`);
      const batch = await res.json();
      repos.push(...batch);
      if (batch.length < 100) break;
    }
  } else {
    const out = execFileSync("gh", ["api", "--paginate", `orgs/${org}/repos?type=all&per_page=100`, "--jq", ".[]"], { maxBuffer: 1 << 28 });
    repos = out.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  return repos
    .filter((r) => includeArchived || !r.archived)
    .map((r) => ({ name: r.name, cloneUrl: r.clone_url, archived: !!r.archived }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Mirror-clone, or bring an existing mirror up to date (all branches, tags and PR refs). */
export function syncMirror(cloneUrl, dir) {
  const env = gitEnv();
  const opts = { env, stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1 << 28 };
  if (existsSync(path.join(dir, "HEAD"))) {
    execFileSync("git", ["-C", dir, "fetch", "--quiet", "--prune", "origin", "+refs/*:refs/*"], opts);
  } else {
    mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", "--quiet", "--mirror", cloneUrl, dir], opts);
  }
}

/**
 * @param {{ repos: {name: string, cloneUrl: string}[], cache: string, baselineDir?: string, writeBaselineDir?: string }} o
 * @returns {Promise<Array<{ name: string, error?: string, files?: number, results?: object[], baseline?: object }>>}
 */
export async function scanOrg({ repos, cache, baselineDir, writeBaselineDir, keep = () => true, onRepo }) {
  const out = [];
  for (const repo of repos) {
    const dir = path.join(cache, `${repo.name}.git`);
    const entry = { name: repo.name };
    try {
      syncMirror(repo.cloneUrl, dir);
      const r = await scan({ mode: "refs", dir });
      r.results = r.results.filter(keep);
      entry.files = r.files;
      entry.results = r.results;
      if (writeBaselineDir) {
        mkdirSync(writeBaselineDir, { recursive: true });
        writeBaseline(path.join(writeBaselineDir, `${repo.name}.json`), r.results);
      } else if (baselineDir && existsSync(path.join(baselineDir, `${repo.name}.json`))) {
        const b = applyBaseline(r.results, loadBaseline(path.join(baselineDir, `${repo.name}.json`)));
        entry.results = b.results;
        entry.baseline = { suppressed: b.suppressed, stale: b.stale };
      }
    } catch (e) {
      // never skip a repository silently: an unreadable repository is reported as such
      entry.error = String(e?.stderr?.toString?.() || e?.message || e).trim().split("\n").pop().slice(0, 200);
    }
    out.push(entry);
    onRepo?.(entry);
  }
  return out;
}
