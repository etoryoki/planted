#!/usr/bin/env node
// planted: look for code planted in a repository (hidden loaders in build configs,
// fake fonts that are JavaScript, editor tasks that run on folder open).
//
//   planted                     working tree of the current directory
//   planted --refs [DIR]        tips of every branch / tag in DIR (nothing is checked out)
//   planted --history [DIR]     every file version in DIR's history
//   options: --json  --min medium|info  --strict (exit 1 on medium too)
import path from "node:path";
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
    else if (a === "-h" || a === "--help") o.help = true;
    else o.dir = a;
  }
  return o;
}

function render(dir, mode, { files, results }) {
  const lines = [`planted ·${path.resolve(dir)} · ${mode} · ${files} file(s) read`];
  if (results.length === 0) return [...lines, "  nothing found"].join("\n");
  const sorted = [...results].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.path.localeCompare(b.path));
  for (const r of sorted) {
    const where = r.where.length > 3 ? `${r.where.slice(0, 3).join(", ")} +${r.where.length - 3}` : r.where.join(", ");
    lines.push(`  [${r.severity.toUpperCase()}] ${r.rule}  ${r.path}${r.line ? ":" + r.line : ""}${r.blob ? "  (blob " + r.blob + ")" : ""}`);
    lines.push(`      ${r.reason}`);
    lines.push(`      in: ${where}`);
  }
  return lines.join("\n");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log("usage: planted [--refs | --history] [DIR] [--json] [--min high|medium|info] [--strict]");
    return;
  }
  const out = await scan(o);
  out.results = out.results.filter((r) => RANK[r.severity] >= (RANK[o.min] ?? RANK[MEDIUM]));
  if (o.json) console.log(JSON.stringify({ dir: path.resolve(o.dir), mode: o.mode, ...out }, null, 2));
  else console.log(render(o.dir, o.mode, out));
  const bad = out.results.some((r) => r.severity === HIGH || (o.strict && r.severity === MEDIUM));
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exitCode = 2;
});
