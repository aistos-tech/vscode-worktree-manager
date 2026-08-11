# Security

## Reporting a vulnerability

**Use [private vulnerability reporting](https://github.com/aistos-tech/vscode-worktree-manager/security/advisories/new), not a public issue.**

Issues are open on this repo, so a report filed there is visible to everyone before anything can be
fixed — and this extension installs itself onto other people's machines, which is exactly the case
where that window matters.

If private reporting is unavailable to you, email `thibault@aistos.fr` instead.

There is no bounty, and no SLA beyond a best effort: this is a small internal tool published because
it is useful, not a supported product.

## What is worth reporting

The extension does four things that are worth an attacker's attention, and each has a documented
control. A way past any of them is a vulnerability.

| Surface | The control |
|---|---|
| **Runs repo-supplied shell commands** — `postCreate` / `preDelete` come from a repo's tracked `.vscode/settings.json` | Approval is fingerprinted over the command **and** the resolved script contents, so a hostile branch that rewrites the script without touching `settings.json` re-prompts. See `src/trust.ts` |
| **Self-update installs a `.vsix`** | Downloaded over HTTPS from this repo's releases and verified against the SHA-256 digest GitHub publishes for the asset. A missing digest aborts. See `src/update.ts` |
| **Renders ticket text in a webview** | `default-src 'none'` with `script-src 'none'`; `img-src` is narrowed to the tracker's own storage. The CSP is the sanitiser, because markdown permits raw HTML and a ticket body is text anyone with workspace access can write |
| **Holds credentials** | A GitHub session from VS Code's built-in provider, and a Linear token in `SecretStorage`. Neither is ever written to the log channel, and no token is embedded in the `.vsix` — the Linear OAuth flow is PKCE with no client secret, because a `.vsix` is a zip anyone can open |

⚠️ **A hook inherits the extension host's environment**, including whatever `GITHUB_TOKEN`,
`ANTHROPIC_API_KEY` or `DATABASE_URL` your shell exports. The API offers no way to subtract them.
That is why hooks are approved per command rather than trusted per repo, and it is documented rather
than hidden — see *Per-repo hooks* in `README.md`.

## Not a vulnerability

- **The trace log records branch names, worktree paths and hook output.** It is a diagnostic channel
  you open deliberately. ⚠️ Do not paste raw trace output into a public issue: it is the one place
  this extension will happily print your internal branch names.
- **Anyone can install this.** There is no licence check and none is planned.

## Supported versions

The latest release only. There are no backports — updating is one command, and
`Aistos: Update…` will offer it to you.
