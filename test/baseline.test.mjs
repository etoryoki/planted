import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyBaseline, loadBaseline, writeBaseline } from "../src/baseline.mjs";
import { scan } from "../src/scan.mjs";

const font = { rule: "fake-binary", severity: "high", path: "public/fonts/a.woff2", blob: "f8566f27", reason: "x", where: ["pull/366/head"] };

function roundTrip(results) {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "planted-bl-")), "baseline.json");
  writeBaseline(f, results);
  return { file: f, known: loadBaseline(f) };
}

test("a known finding in a known place is not reported, but counted", () => {
  const { known } = roundTrip([font]);
  const r = applyBaseline([font], known);
  assert.equal(r.results.length, 0);
  assert.equal(r.suppressed, 1);
  assert.equal(r.stale, 0);
});

test("the same file on a new branch is reported, for the new branch only", () => {
  const { known } = roundTrip([font]);
  const r = applyBaseline([{ ...font, where: ["pull/366/head", "feature/new"] }], known);
  assert.equal(r.results.length, 1);
  assert.deepEqual(r.results[0].where, ["feature/new"]);
  assert.equal(r.suppressed, 0);
});

test("a different file at the same path is new", () => {
  const { known } = roundTrip([font]);
  const r = applyBaseline([{ ...font, blob: "0badc0de" }], known);
  assert.equal(r.results.length, 1);
});

test("mirror names and CI clone names match (origin/ prefix)", () => {
  const { known } = roundTrip([{ ...font, where: ["develop"] }]);
  assert.equal(applyBaseline([{ ...font, where: ["origin/develop", "develop"] }], known).results.length, 0);
});

test("entries that are gone are counted as stale", () => {
  const { known } = roundTrip([font, { ...font, path: "other.woff2" }]);
  assert.equal(applyBaseline([font], known).stale, 1);
});

test("the baseline never stores file contents, only where and why", () => {
  const { file } = roundTrip([font]);
  const e = JSON.parse(readFileSync(file, "utf8")).entries[0];
  assert.deepEqual(Object.keys(e).sort(), ["blob", "path", "reason", "rule", "severity", "where"]);
});

test("end to end: nightly run over refs reports only what is new", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "planted-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(path.join(dir, "public", "fonts"), { recursive: true });
  writeFileSync(path.join(dir, "public", "fonts", "a.woff2"), "var a=function(){};\n");
  g("add", "-A");
  g("commit", "-q", "-m", "old infection");
  g("branch", "old");
  const { known } = roundTrip((await scan({ mode: "refs", dir })).results);
  // an attacker drops the same file on a new branch
  g("branch", "feature/x");
  const after = applyBaseline((await scan({ mode: "refs", dir })).results, known);
  assert.deepEqual(after.results.map((r) => r.where), [["feature/x"]]);
});
