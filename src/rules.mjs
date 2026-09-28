// Detection rules. Each rule looks at one file (path + bytes) and returns findings.
// Signals are structural (hidden code after whitespace, a "font" that is text, an
// auto-running editor task, a build config that fetches and evaluates code) rather than
// one campaign's strings, so a renamed variant still trips at least one of them.
// Contents are only read as data. Nothing is ever executed.

export const HIGH = "high";
export const MEDIUM = "medium";
export const INFO = "info";

const CODE_EXT = /\.(?:[cm]?[jt]sx?|json|vue|svelte|astro)$/i;
const BINARY_EXT = /\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|ico|webp)$/i;
// Any `*.config.*` counts (a name list missed drizzle.config.ts), plus files that tools load
// on their own without that suffix.
const CONFIG_FILE =
  /(?:^|\/)(?:[\w.-]+\.config(?:\.[\w-]+)*\.[cm]?[jt]s|\.[\w-]+rc\.[cm]?[jt]s|\.eslintrc|middleware\.[jt]s|instrumentation\.[jt]s|gatsby-(?:node|browser|ssr)\.[jt]s|knexfile\.[jt]s|Gruntfile\.[jt]s|gulpfile\.[cm]?[jt]s)$/i;

// A run of blanks with more code after it on the same line. Seen samples use exactly 149
// blanks, so no single threshold is safe: a shorter run counts when the line is also very
// long, and very long lines in build configs count on their own.
const BLANK_RUN = /[ \t  -​　]{40,}(?=\S)/g;
const LONG_BLANK_RUN = 120;
const LONG_LINE = 1000;
const CONFIG_LONG_LINE = 3000;
// In every seen sample the blanks start right after the visible code (column 2–22). Deep
// inside a bundled line, blanks are just a template string.
const BLANK_RUN_MAX_COLUMN = 200;
const EXECUTABLE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|bat|cmd|ps1|sh)$/i;
const KNOWN_MARKERS = [
  { re: /global\[\s*['"]!['"]\s*\]\s*=/, name: "global['!'] loader marker" },
  { re: /\b_\$_[0-9a-f]{4}\b/, name: "obfuscator array marker" },
];
const EXEC = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]|child_process|\bexecSync\s*\(|\bspawnSync\s*\(|\bvm\.runIn/;
const NET = /\bfetch\s*\(|\bhttps?\.(?:get|request)\s*\(|\baxios\b|XMLHttpRequest|node-fetch|\bWebSocket\s*\(|\bimport\s*\(\s*['"`]https?:/;
const DECODE = /\batob\s*\(|Buffer\.from\([^)]{0,200}['"](?:base64|hex)['"]|fromCharCode\s*\(|(?:\\x[0-9a-f]{2}){24,}/i;
// what a hidden payload starts with, right after the blanks that push it off-screen
const PAYLOAD_START = /^(?:[;,)}\]\s]*)(?:eval\b|(?:new\s+)?Function\b|global\s*\[|globalThis\s*\[|require\s*\(|import\s*\(|atob\b|\(\s*function\b|!function\b|\(\s*\(\s*\)\s*=>|var\s+_0x|const\s+_0x|let\s+_0x|_0x[0-9a-f]{4})/i;
const CREATE_REQUIRE = /\bcreateRequire\s*\(/;
// evaluate what was just decoded or fetched, in any file: eval(atob(…)), new Function(Buffer.from(…,'base64')…)
const EVAL_NEAR = /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/g;
const PAYLOAD_SOURCE = /\batob\s*\(|['"]base64['"]|\bfetch\s*\(|\bhttps?\.get\s*\(|\.text\s*\(\s*\)/;
const NEAR = 300;

// Findings never quote the file: the text after a hit is the payload itself, and writing it
// into a report makes antivirus quarantine the report (seen on Windows Defender).
/** @typedef {{ rule: string, severity: string, reason: string, line?: number }} Finding */

// A renamed but real file (a PNG saved as .ico, a JPEG as .png) is fine: only the family
// has to match, fonts with fonts and images with images.
function magicOk(ext, b) {
  const s = (o, t) => b.length >= o + t.length && b.subarray(o, o + t.length).toString("latin1") === t;
  const font = s(0, "wOFF") || s(0, "wOF2") || s(0, "\x00\x01\x00\x00") || s(0, "true") || s(0, "OTTO") || s(0, "ttcf") || s(34, "LP");
  const image =
    s(0, "\x89PNG") || s(0, "\xff\xd8\xff") || s(0, "GIF8") || s(0, "\x00\x00\x01\x00") || s(0, "\x00\x00\x02\x00") ||
    (s(0, "RIFF") && s(8, "WEBP")) || s(0, "BM") || s(4, "ftypavif");
  return /^(?:woff2?|ttf|otf|eot)$/.test(ext) ? font : image;
}

function printableRatio(b) {
  const n = Math.min(b.length, 4096);
  if (n === 0) return 0;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0x80) p++;
  }
  return p / n;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * A committed env file. Judged by name only: its contents are secrets and are never read.
 * (One campaign also stored its payload URL, base64-encoded, in a committed `.env`.)
 */
export function isSecretFile(path) {
  const name = path.replace(/\\/g, "/").split("/").pop();
  // `.env.mysql.example`, `.env.e2e.sample`: a template anywhere in the name is not a secret
  return /^\.env(?:\.[\w.-]+)?$/i.test(name) && !/\.(?:example|sample|template|dist|defaults)(?:\.|$)/i.test(name);
}

export function secretFileFinding() {
  return { rule: "committed-env-file", severity: MEDIUM, reason: "an env file is committed (contents not read): rotate what it holds and ignore it" };
}

/** Should this path be read at all? Keeps scans of large histories cheap. */
export function isRelevant(path) {
  const p = path.replace(/\\/g, "/");
  return (
    CODE_EXT.test(p) ||
    BINARY_EXT.test(p) ||
    /\.svg$/i.test(p) ||
    /(?:^|\/)\.vscode\/(?:tasks|settings|launch)\.json$/.test(p) ||
    /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p) ||
    /(?:^|\/)\.gitignore$/.test(p) ||
    /\.(?:bat|cmd|ps1|sh)$/i.test(p)
  );
}

/**
 * @param {string} path repository-relative path with forward slashes
 * @param {Buffer} buf file contents
 * @returns {Finding[]}
 */
export function scanFile(path, buf) {
  const p = path.replace(/\\/g, "/");
  const findings = [];
  const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();

  // 1) a font / image that is not one (an empty placeholder is just empty)
  if (BINARY_EXT.test(p)) {
    if (buf.length > 0 && !magicOk(ext, buf)) {
      const text = printableRatio(buf) > 0.95 ? buf.subarray(0, 8192).toString("utf8") : null;
      if (text && /^\s*<(?:!doctype html|html)/i.test(text)) {
        findings.push({ rule: "fake-binary", severity: INFO, reason: `.${ext} file is an HTML page (probably a broken download, not code)` });
      } else if (text && /(?:\bfunction\b|=>|\brequire\s*\(|\bglobal\[|\bvar\s|\bconst\s|\blet\s|\beval\b|\bFunction\b|;\s*$)/m.test(text)) {
        findings.push({ rule: "fake-binary", severity: HIGH, reason: `.${ext} file contains JavaScript, not a real .${ext}` });
      } else {
        findings.push({ rule: "fake-binary", severity: MEDIUM, reason: `.${ext} file does not start with the .${ext} signature` });
      }
    }
    return findings;
  }

  if (printableRatio(buf) < 0.9) return findings; // some other binary
  const text = buf.toString("utf8");

  // 2) code hidden to the right of a long run of blanks
  if (EXECUTABLE_EXT.test(p) && !/\.min\.[cm]?js$/i.test(p)) {
    let hit = null;
    for (const m of text.matchAll(BLANK_RUN)) {
      const start = text.lastIndexOf("\n", m.index) + 1;
      const endNl = text.indexOf("\n", m.index);
      const lineLen = (endNl < 0 ? text.length : endNl) - start;
      // what follows the blanks decides first, so trimming the run or the line length does
      // not get a payload through; the size limits catch payloads that start innocuously
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 200);
      // blanks at the start of a line are indentation, not hiding
      if (m.index > start && PAYLOAD_START.test(after)) {
        hit = { m, lineLen };
        break;
      }
      if (m.index - start > BLANK_RUN_MAX_COLUMN) continue;
      if (m[0].length >= LONG_BLANK_RUN || lineLen >= LONG_LINE) {
        hit = { m, lineLen };
        break;
      }
    }
    if (hit) {
      findings.push({
        rule: "hidden-after-blanks",
        severity: HIGH,
        reason: `code after ${hit.m[0].length} blanks on a ${hit.lineLen}-character line (pushed off-screen)`,
        line: lineOf(text, hit.m.index),
      });
    } else if (CONFIG_FILE.test(p)) {
      const longest = text.split("\n").reduce((a, l, i) => (l.length > a.len ? { len: l.length, line: i + 1 } : a), { len: 0, line: 0 });
      if (longest.len >= CONFIG_LONG_LINE)
        findings.push({ rule: "hidden-after-blanks", severity: HIGH, reason: `build config has a ${longest.len}-character line`, line: longest.line });
    }
  }

  // 3) known loader markers (cheap extra signal; variants are caught by the others)
  if (CODE_EXT.test(p)) {
    for (const k of KNOWN_MARKERS) {
      const m = k.re.exec(text);
      if (m) findings.push({ rule: "known-marker", severity: HIGH, reason: k.name, line: lineOf(text, m.index) });
    }
  }

  // 4a) any code that evaluates what it just decoded or fetched
  if (EXECUTABLE_EXT.test(p) && !CONFIG_FILE.test(p)) {
    for (const m of text.matchAll(EVAL_NEAR)) {
      const around = text.slice(Math.max(0, m.index - NEAR), m.index + NEAR);
      const src = PAYLOAD_SOURCE.exec(around);
      if (src) {
        findings.push({ rule: "decode-exec", severity: HIGH, reason: `evaluates code (${m[0].trim()}) next to ${src[0].trim()}`, line: lineOf(text, m.index) });
        break;
      }
    }
  }

  // 4b) build / framework config that runs code it fetches or decodes
  if (CONFIG_FILE.test(p)) {
    const exec = EXEC.exec(text);
    const net = NET.exec(text);
    const dec = DECODE.exec(text);
    const creq = CREATE_REQUIRE.exec(text);
    if (exec && (net || dec)) {
      findings.push({
        rule: "config-fetch-exec",
        severity: HIGH,
        reason: `build config evaluates code (${exec[0].trim()}) and ${net ? "fetches (" + net[0].trim() + ")" : "decodes (" + dec[0].trim() + ")"}`,
        line: lineOf(text, exec.index),
      });
    } else if (exec) {
      findings.push({ rule: "config-exec", severity: MEDIUM, reason: `build config evaluates or spawns code (${exec[0].trim()})`, line: lineOf(text, exec.index) });
    } else if (creq && (net || dec)) {
      findings.push({ rule: "config-fetch-exec", severity: MEDIUM, reason: `build config uses createRequire together with ${net ? "a network call" : "decoding"}`, line: lineOf(text, creq.index) });
    }
  }

  // 5) editor task that runs when the folder is opened
  if (/(?:^|\/)\.vscode\/tasks\.json$/.test(p)) {
    const m = /"runOn"\s*:\s*"folderOpen"/.exec(text);
    if (m) {
      const stealth = /"reveal"\s*:\s*"never"|"hide"\s*:\s*true|"echo"\s*:\s*false/.test(text);
      const nodeRun = /"command"\s*:\s*"[^"]*\bnode\b|"args"\s*:\s*\[[^\]]*\.(?:woff2?|ttf|otf|png|jpe?g|ico)"/.test(text);
      findings.push({
        rule: "vscode-autorun",
        severity: stealth || nodeRun ? HIGH : MEDIUM,
        reason: `task runs automatically when the folder is opened${stealth ? ", hidden from the user" : ""}${nodeRun ? ", runs node on a non-code file" : ""}`,
        line: lineOf(text, m.index),
      });
    }
  }

  // 6) editor settings that allow automatic tasks
  if (/(?:^|\/)\.vscode\/settings\.json$/.test(p)) {
    const m = /"task\.allowAutomaticTasks"\s*:\s*(?:"on"|true)/.exec(text);
    if (m) findings.push({ rule: "vscode-allow-autorun", severity: HIGH, reason: "workspace settings allow automatic tasks", line: lineOf(text, m.index) });
  }

  // 7a) package.json scripts: install hooks run on `npm install`, before any build step
  if (/(?:^|\/)package\.json$/.test(p)) {
    let pkg = null;
    try {
      pkg = JSON.parse(text);
    } catch {}
    const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts ? pkg.scripts : {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== "string") continue;
      const lifecycle = /^(?:pre|post)?(?:install|prepare|prepublish|prepack)$/.test(name);
      const bad =
        /\bnode\s+(?:-e|--eval|-p|--print)\b[\s\S]*(?:eval|Function|atob|base64|fetch|https?:)/.test(cmd) ||
        /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|;&]*[|]\s*(?:sh|bash|node|iex|powershell)\b/i.test(cmd) ||
        /\bnode\s+[^\s;&|]+\.(?:woff2?|ttf|otf|eot|png|jpe?g|gif|ico|svg|txt|json|md)\b/i.test(cmd) ||
        /[A-Za-z0-9+/]{200,}={0,2}/.test(cmd);
      if (bad) {
        findings.push({ rule: "package-script", severity: HIGH, reason: `script "${name}" downloads, decodes or runs hidden code${lifecycle ? " (runs on npm install)" : ""}`, line: lineOf(text, text.indexOf(`"${name}"`)) });
      } else if (lifecycle && /\bnode\s+(?:-e|--eval)\b|\b(?:curl|wget)\b/.test(cmd)) {
        findings.push({ rule: "package-script", severity: MEDIUM, reason: `install hook "${name}" runs inline code or downloads`, line: lineOf(text, text.indexOf(`"${name}"`)) });
      }
    }
  }

  // 7b) an SVG that carries script
  if (/\.svg$/i.test(p)) {
    const m = /<script\b|\bon(?:load|error|click|mouseover)\s*=|javascript:/i.exec(text);
    if (m) findings.push({ rule: "svg-script", severity: MEDIUM, reason: "SVG contains script or an event handler", line: lineOf(text, m.index) });
  }

  // 7c) .gitignore carrying a known dropper name
  if (/(?:^|\/)\.gitignore$/.test(p)) {
    const m = /^\s*\/?config\.bat\s*$/m.exec(text);
    if (m) findings.push({ rule: "gitignore-dropper", severity: MEDIUM, reason: "`.gitignore` hides config.bat (seen in this campaign)", line: lineOf(text, m.index) });
  }

  // 8) workflow that asks for a write token (hygiene, not malware)
  if (/(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) {
    const m = /permissions:\s*write-all|^\s*contents:\s*write\b/m.exec(text);
    if (m) findings.push({ rule: "workflow-write-token", severity: INFO, reason: "workflow requests a write token (overrides the org default)", line: lineOf(text, m.index) });
  }

  return findings;
}
