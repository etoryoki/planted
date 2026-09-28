# planted

Finds code a compromised account planted in your repo — before your build or editor runs it.

When a developer's machine is infected, the attacker can push with their credentials to
every repository they can reach: a loader pushed off-screen in `postcss.config.mjs`, a
"font" that is JavaScript, a VS Code task that runs when the folder is opened, a build
config that fetches and evaluates code. These run the moment someone builds the project or
opens the folder. `planted` looks for them.

It only **reads** files. Branches are read straight from git objects, so nothing is checked
out and nothing is executed. Findings never quote file contents (the text after a hit is the
payload itself). No dependencies: Node.js 20+ and git.

```sh
git clone https://github.com/etoryoki/planted
node planted/src/cli.mjs                 # working tree of the current directory
node planted/src/cli.mjs --refs DIR      # tips of every branch, tag and PR ref in DIR
node planted/src/cli.mjs --history DIR   # every version of every relevant file in DIR's history
```

To check every branch and PR of a GitHub repository without checking anything out:

```sh
git clone --mirror https://github.com/OWNER/REPO repo.git
node planted/src/cli.mjs --refs repo.git
```

Options: `--json`, `--min high|medium|info` (default `medium`), `--strict` (exit 1 on medium too).
Exit code: `1` when a high finding exists, `0` otherwise, `2` on error.

### A whole organization, from one place

```sh
node planted/src/cli.mjs --org ORG --cache .planted-cache --baseline-dir baselines
```

Mirror-clones every repository (all branches, tags and PR refs; kept in `--cache` and only
fetched after the first run) and checks every tip. Repositories without CI are covered, and
an attacker cannot switch it off from inside a repository. Authentication: `PLANTED_TOKEN`
(or `GH_TOKEN` / `GITHUB_TOKEN`), passed to git through config in the environment, never in a
URL; without a token, a logged-in `gh` and git's credential helper are used. A repository that
cannot be read is reported, never skipped. For a nightly job see
[docs/org-watch.yml](docs/org-watch.yml).

### Baseline: report only what is new

Some findings cannot be removed (a PR ref on GitHub keeps an old infected commit). Record
what you have reviewed, and later runs report only what is new:

```sh
node planted/src/cli.mjs --refs repo.git --write-baseline planted-baseline.json   # review this file
node planted/src/cli.mjs --refs repo.git --baseline planted-baseline.json
```

- An entry is a rule + path + file (blob) + **the branches and PRs it was seen on**. The same
  file dropped on a new branch is reported again, for the new branch.
- Every run prints how many findings the baseline hid, and entries that are no longer found.
- The baseline file can hide a payload if an attacker edits it. Keep it outside the scanned
  repository, or require review for changes to it (CODEOWNERS + a ruleset).

A step-by-step rollout guide (in Japanese) is in [docs/guide.ja.md](docs/guide.ja.md).

## In GitHub Actions: stop the build

Run it in its own job and make the build wait for it. Pin to a commit SHA.

```yaml
permissions:
  contents: read

jobs:
  planted:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - name: Check for planted code
        run: |
          git clone --quiet https://github.com/etoryoki/planted "$RUNNER_TEMP/planted"
          git -C "$RUNNER_TEMP/planted" checkout --quiet <COMMIT_SHA>
          node "$RUNNER_TEMP/planted/src/cli.mjs" .

  build:
    needs: planted
    # ... your install / build steps
```

Run `--refs` over a mirror clone on a schedule (nightly) rather than on every PR: it reads
every branch and PR ref.

## Trusting this tool

A tool that looks for code planted through a compromised account can itself be a target.
Pin a commit SHA (as above) and read the diff before moving the pin. The code is a few
hundred lines with no dependencies so that it can be read in one sitting. It is not on npm yet.

## What it looks for

| Rule | Severity | Signal |
|---|---|---|
| `hidden-after-blanks` | high | code pushed off-screen: blanks after code on the same line followed by `eval`, `Function`, `global[`, `require(`, … ; or a long run of blanks near the left of a long line; or a very long line in a build config. Indentation does not count |
| `known-marker` | high | known loader markers (cheap extra signal only) |
| `fake-binary` | high / medium / info | a font or image whose bytes are not a font or image. JavaScript inside = high; an HTML page (broken download) = info |
| `config-fetch-exec` | high / medium | a build config (any `*.config.*`, `.xxxrc.js`, `.eslintrc`, `middleware`, …) that evaluates code **and** fetches or decodes it |
| `config-exec` | medium | a build config that evaluates or spawns code |
| `decode-exec` | high | any code that evaluates (`eval`, `new Function`) right next to decoding or fetching (`atob`, base64, `fetch`) |
| `committed-env-file` | medium | an env file is committed. Judged by name only; the contents are never read |
| `package-script` | high / medium | a `package.json` script that pipes a download to a shell, runs `node` on a font or image, or decodes inline code; install hooks that run inline code |
| `svg-script` | medium | an SVG with a script or an event handler |
| `commit-timezone` | medium / info | a commit made from a time zone its committer (almost) never uses, differing from the author's. Medium when the committer time equals the author time (a forged rewrite); a real squash or cherry-pick is committed later and stays info. `--refs` judges branch tips only |
| `vscode-autorun` | high / medium | `.vscode/tasks.json` task with `runOn: folderOpen`; high when hidden or running `node` on a non-code file |
| `vscode-allow-autorun` | high | `.vscode/settings.json` enabling `task.allowAutomaticTasks` |
| `gitignore-dropper` | medium | `.gitignore` hiding `config.bat` |
| `workflow-write-token` | info | a workflow asking for a write token (overrides a read-only org default) |

The signals are structural on purpose: a single string or a single round threshold is easy
to step around (seen samples used exactly 149 blanks).

## Tests

```sh
node --test test/rules.test.mjs
```

Test samples are inert stand-ins with the same shape as real payloads. They are never run.
