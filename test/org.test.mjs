import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanOrg } from "../src/org.mjs";

function repo(root, name, files) {
  const dir = path.join(root, "src", name);
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), body);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

test("every repository is mirrored and checked; an unreadable one is reported, not skipped", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "planted-org-"));
  const clean = repo(root, "clean", { "postcss.config.mjs": "export default {};\n" });
  const bad = repo(root, "infected", { "README.md": "x\n" });
  // the infection sits only on a side branch, as in a mass force-push
  bad.g("switch", "-q", "-c", "feature/x");
  mkdirSync(path.join(bad.dir, "public", "fonts"), { recursive: true });
  writeFileSync(path.join(bad.dir, "public", "fonts", "fa-solid-900.woff2"), "var a=function(){};\n");
  bad.g("add", "-A");
  bad.g("commit", "-q", "-m", "planted");
  bad.g("switch", "-q", "main");

  const repos = [
    { name: "clean", cloneUrl: clean.dir },
    { name: "infected", cloneUrl: bad.dir },
    { name: "gone", cloneUrl: path.join(root, "src", "does-not-exist") },
  ];
  const cache = path.join(root, "cache");
  const report = await scanOrg({ repos, cache });
  const by = Object.fromEntries(report.map((e) => [e.name, e]));
  assert.equal(by.clean.results.length, 0);
  assert.deepEqual(by.infected.results.map((r) => `${r.rule} ${r.where.join(",")}`), ["fake-binary feature/x"]);
  assert.ok(by.gone.error);

  // record what was reviewed; the next night only something new is reported
  const baselines = path.join(root, "baselines");
  await scanOrg({ repos: repos.slice(0, 2), cache, writeBaselineDir: baselines });
  let again = await scanOrg({ repos: repos.slice(0, 2), cache, baselineDir: baselines });
  assert.deepEqual(again.map((e) => e.results.length), [0, 0]);
  assert.equal(again[1].baseline.suppressed, 1);

  // the attacker drops the same file on another branch: the existing mirror is updated and it shows up
  bad.g("branch", "feature/y", "feature/x");
  again = await scanOrg({ repos: repos.slice(0, 2), cache, baselineDir: baselines });
  assert.deepEqual(again[1].results.map((r) => r.where), [["feature/y"]]);
});
