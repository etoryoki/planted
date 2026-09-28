// Known findings, so a scheduled check only reports what is new.
//
// An entry is a rule + path + blob (or commit) + the places it was seen. The places matter:
// campaigns drop the same file (same blob) on many branches, so an entry never covers a
// branch or PR it was not recorded on. Entries never quote file contents.
import { readFileSync, writeFileSync } from "node:fs";

const keyOf = (r) => `${r.rule}\u0000${r.path}\u0000${r.blob ?? ""}`;
// a mirror clone lists `develop`, a CI clone `origin/develop`: the same place
const place = (w) => w.replace(/^origin\//, "");

/** @returns {Map<string, Set<string>>} key -> places */
export function loadBaseline(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error(`${file}: not a planted baseline (version 1)`);
  const known = new Map();
  for (const e of data.entries) known.set(keyOf(e), new Set((e.where ?? []).map(place)));
  return known;
}

export function writeBaseline(file, results) {
  const entries = results
    .map((r) => ({ rule: r.rule, severity: r.severity, path: r.path, ...(r.blob ? { blob: r.blob } : {}), where: [...new Set(r.where.map(place))].sort(), reason: r.reason }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
  writeFileSync(file, JSON.stringify({ version: 1, created: new Date().toISOString(), entries }, null, 2) + "\n");
  return entries.length;
}

/**
 * Drop what the baseline already knows. A finding seen in new places is kept, narrowed to
 * the new places.
 * @returns {{ results: object[], suppressed: number, stale: number }}
 */
export function applyBaseline(results, known) {
  const kept = [];
  const seen = new Set();
  let suppressed = 0;
  for (const r of results) {
    const k = keyOf(r);
    const places = known.get(k);
    if (!places) {
      kept.push(r);
      continue;
    }
    seen.add(k);
    const fresh = r.where.filter((w) => !places.has(place(w)));
    if (fresh.length === 0) suppressed++;
    else kept.push({ ...r, where: fresh, reason: `${r.reason} (known elsewhere, new here)` });
  }
  const stale = [...known.keys()].filter((k) => !seen.has(k)).length;
  return { results: kept, suppressed, stale };
}
