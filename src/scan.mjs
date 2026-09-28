import { scanFile, secretFileFinding } from "./rules.mjs";
import { blobsAtRefs, blobsInHistory, commitTimezoneAnomalies, listRefs, readBlobs, worktreeFiles } from "./sources.mjs";

/**
 * @param {{ mode: "worktree" | "refs" | "history", dir: string }} o
 * @returns {Promise<{ files: number, results: Array<object> }>}
 */
export async function scan({ mode, dir }) {
  const results = [];
  let files = 0;
  if (mode === "worktree") {
    for (const f of worktreeFiles(dir)) {
      files++;
      for (const x of scanFile(f.path, f.buf)) results.push({ ...x, path: f.path, where: f.where });
    }
    return { files, results };
  }
  const blobs = mode === "refs" ? blobsAtRefs(dir, listRefs(dir)) : blobsInHistory(dir);
  const toRead = [];
  for (const [sha, b] of blobs) {
    // committed env files are reported by name; their contents are never read
    if (b.secret) results.push({ ...secretFileFinding(), path: b.path, where: b.where, blob: sha.slice(0, 8) });
    else toRead.push(sha);
  }
  for await (const { sha, buf } of readBlobs(dir, toRead)) {
    files++;
    const b = blobs.get(sha);
    for (const x of scanFile(b.path, buf)) results.push({ ...x, path: b.path, where: b.where, blob: sha.slice(0, 8) });
  }
  for (const c of commitTimezoneAnomalies(dir, mode === "refs")) results.push(c);
  return { files, results };
}
