#!/usr/bin/env node
// planted: look for code planted in a repository (hidden loaders in build configs,
// fake fonts that are JavaScript, editor tasks that run on folder open).
//
//   planted                     working tree of the current directory
//   planted --refs [DIR]        tips of every branch / tag in DIR (nothing is checked out)
//   planted --history [DIR]     every file version in DIR's history
//   options: --json  --min medium|info  --strict (exit 1 on medium too)
//            --baseline FILE (report only what FILE does not know)  --write-baseline FILE
//   planted --org ORG           every repository of a GitHub organization, all refs
//            --cache DIR  --baseline-dir DIR  --write-baseline-dir DIR  --no-archived
import path from "node:path";
import { applyBaseline, loadBaseline, writeBaseline } from "./baseline.mjs";
import { listOrgRepos, scanOrg } from "./org.mjs";
import { HIGH, INFO, MEDIUM } from "./rules.mjs";
import { scan } from "./scan.mjs";

const RANK = { [HIGH]: 3, [MEDIUM]: 2, [INFO]: 1 };

function parseArgs(argv) {
  const o = { mode: "worktree", dir: ".", json: false, min: MEDIUM, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refs") o.mode = "refs";
    else if (a === "--history") o.mode = "history";
    else if (a === "--json") o.json = true;
    else if (a === "--strict") o.strict = true;
    else if (a === "--min") o.min = argv[++i];
    else if (a === "--baseline") o.baseline = argv[++i];
    else if (a === "--write-baseline") o.writeBaseline = argv[++i];
    else if (a === "--org") o.org = argv[++i];
    else if (a === "--cache") o.cache = argv[++i];
    else if (a === "--baseline-dir") o.baselineDir = argv[++i];
    else if (a === "--write-baseline-dir") o.writeBaselineDir = argv[++i];
    else if (a === "--no-archived") o.noArchived = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else o.dir = a;
  }
  return o;
}

function render(dir, mode, out) {
  return [`planted · ${path.resolve(dir)} · ${mode} · ${out.files} file(s) read`, ...renderFindings(out)].join("\n");
}

function renderFindings({ results, baseline }) {
  const lines = [];
  // always say how much the baseline hid: an edited baseline is how a payload would hide
  if (baseline) {
    lines.push(`  baseline${baseline.file ? " " + baseline.file : ""}: ${baseline.suppressed} known finding(s) not shown${baseline.stale ? `, ${baseline.stale} entr${baseline.stale === 1 ? "y" : "ies"} no longer found` : ""}`);
  }
  if (results.length === 0) return [...lines, baseline ? "  nothing new" : "  nothing found"];
  const sorted = [...results].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.path.localeCompare(b.path));
  for (const r of sorted) {
    const where = r.where.length > 3 ? `${r.where.slice(0, 3).join(", ")} +${r.where.length - 3}` : r.where.join(", ");
    lines.push(`  [${r.severity.toUpperCase()}] ${r.rule}  ${r.path}${r.line ? ":" + r.line : ""}${r.blob ? "  (blob " + r.blob + ")" : ""}`);
    lines.push(`      ${r.reason}`);
    lines.push(`      in: ${where}`);
  }
  return lines;
}

async function orgMain(o) {
  const keep = (r) => RANK[r.severity] >= (RANK[o.min] ?? RANK[MEDIUM]);
  const repos = await listOrgRepos(o.org, { includeArchived: !o.noArchived });
  if (!o.json) console.log(`planted · ${o.org} · ${repos.length} repositories · all branches, tags and PR refs`);
  const report = await scanOrg({
    repos,
    cache: o.cache ?? ".planted-cache",
    baselineDir: o.baselineDir,
    writeBaselineDir: o.writeBaselineDir,
    keep,
    onRepo: (e) => {
      if (o.json) return;
      if (e.error) console.log(`\n== ${e.name}\n  [ERROR] could not read: ${e.error}`);
      else if (o.writeBaselineDir) console.log(`== ${e.name}: ${e.results.length} finding(s) recorded`);
      else if (e.results.length || e.baseline?.suppressed) console.log(`\n== ${e.name} (${e.files} file(s) read)\n${renderFindings(e).join("\n")}`);
    },
  });
  const failed = report.filter((e) => e.error);
  const withHigh = report.filter((e) => e.results?.some((r) => r.severity === HIGH || (o.strict && r.severity === MEDIUM)));
  if (o.json) console.log(JSON.stringify({ org: o.org, repos: report }, null, 2));
  else if (o.writeBaselineDir) console.log(`\nplanted · baselines written to ${o.writeBaselineDir}. Review them before relying on them.`);
  else {
    const clean = report.length - failed.length - report.filter((e) => e.results?.length).length;
    console.log(`\nplanted · ${report.length} repositories: ${withHigh.length} with new high findings, ${failed.length} unreadable, ${clean} with nothing ${o.baselineDir ? "new" : "found"}`);
  }
  process.exitCode = withHigh.length ? 1 : failed.length ? 2 : 0;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("usage: planted [--refs | --history] [DIR] [--json] [--min high|medium|info] [--strict] [--baseline FILE] [--write-baseline FILE]");
    console.log("       planted --org ORG [--cache DIR] [--baseline-dir DIR | --write-baseline-dir DIR] [--no-archived] [--json] [--min ...] [--strict]");
    return;
  }
  if (o.org) return orgMain(o);
  const out = await scan(o);
  out.results = out.results.filter((r) => RANK[r.severity] >= (RANK[o.min] ?? RANK[MEDIUM]));
  if (o.writeBaseline) {
    const n = writeBaseline(o.writeBaseline, out.results);
    console.log(`planted · wrote ${n} finding(s) to ${o.writeBaseline}. Review it before relying on it: everything in it stops being reported where it was seen.`);
    return;
  }
  if (o.baseline) {
    const b = applyBaseline(out.results, loadBaseline(o.baseline));
    out.results = b.results;
    out.baseline = { file: o.baseline, suppressed: b.suppressed, stale: b.stale };
  }
  if (o.json) console.log(JSON.stringify({ dir: path.resolve(o.dir), mode: o.mode, ...out }, null, 2));
  else console.log(render(o.dir, o.mode, out));
  const bad = out.results.some((r) => r.severity === HIGH || (o.strict && r.severity === MEDIUM));
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 2;
});
