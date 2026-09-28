# Security policy

## Reporting a vulnerability in planted

Use **[Report a vulnerability](https://github.com/etoryoki/planted/security/advisories/new)**
(GitHub private vulnerability reporting). Please do not open a public issue for these.

In scope — problems in planted itself, for example:

- anything that makes planted execute, `require` or evaluate content it reads
- a crafted repository that makes planted write files, leak a token, or hang forever
- a report that quotes file contents (planted must never print a payload)
- a way for the tool's own distribution to be tampered with

planted is maintained by one person, without paid support or an SLA. Reports are handled as
soon as they are seen; a private report notifies the maintainer directly.

## Reporting a detection gap

Code that is planted but not found, or a clean file reported as planted, is not a
vulnerability in planted. Open a normal
[issue](https://github.com/etoryoki/planted/issues) with the rule name, the kind of file
(for example `postcss.config.mjs`) and the shape of the problem (for example "loader after 90
blanks on a 400-character line"). **Do not paste payloads, repository names or secrets.**
If describing the gap would show others how to get around planted before it is fixed, use
the private report above instead.

## How planted protects itself

planted looks for code planted through compromised accounts, so its own supply chain is part
of its threat model:

- **Pin a commit SHA**, never a branch, and read the diff before moving the pin
  (`git log -p <old>..<new>`). The README and the guides use pinned SHAs.
- **No dependencies.** Node.js and git only, so there is no third-party package to hijack.
- **Read-only.** planted reads files and git objects. It never checks out a branch, installs
  anything or runs what it reads.
- **Small enough to read.** About 800 lines in `src/`.
- The maintainer's GitHub account uses two-factor authentication.
- Not on npm yet. When it is, releases will be published from GitHub Actions with npm
  provenance, so a package can be traced to the commit and workflow that built it.

Commits are not signed yet.
