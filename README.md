# Worktree Manager

Per-worktree identity and fast switching for git worktrees in VS Code.

## What it does

- **Status bar identity** — shows the current worktree's folder name in a colour derived from
  that name. Writes no settings file; `StatusBarItem.color` accepts a raw hex.
- **Switcher** — `ctrl+shift+w` opens a quick pick of every worktree in the repo and opens the
  chosen one **in the same window**. Pinned worktrees sort first.
- **Recency order** — within each group, worktrees are ordered by when they were last opened, most
  recent first; one never opened falls back to its creation date, newest first. "Opened" is
  recorded on activation, not on switch, so arriving via VS Code's recent list or `code <path>`
  counts too. The creation date is the birth time of the git admin directory, which is why it
  survives `git worktree move` — the worktree folder's own timestamps do not.
- **Pins** — pin/unpin from the button on each quick pick row. Stored in `globalState`, keyed by
  the git admin directory name, which survives `git worktree move`.
- **Rename** — `Worktree: Rename…`, or the pencil button on any quick pick row. Runs
  `git worktree move`, then reopens the window if you renamed the one you're in. The VS Code
  title follows automatically, since the default `window.title` contains `${rootName}`.
  Pin and colour survive, because they key on the admin directory rather than the folder name.
- **Delete** — `Worktree: Delete…`, or the trash button on any quick pick row. Runs the repo's
  `preDelete` hook if it has one, then `git worktree remove`, behind a modal confirmation that
  names the hook command. A **locked** worktree is refused before anything runs. A **prunable**
  one — directory already gone — offers to clear its git registration instead, since there is
  nothing left to tear down. Uncommitted changes are listed and consented to *before* the hook
  runs, not after git refuses. The branch is always kept. Deleting the worktree you're in reopens
  the window at the primary worktree. Pin and colour entries are released.
- **Create** — `Worktree: Create…`, or the `$(add)` row in the switcher. Prompts for a branch, a
  source to fork from (skipped when the branch already exists), and a destination, then runs the
  repo's `postCreate` hook and offers **Open** / **Open in New Window** / **Stay**. The create row's
  label embeds whatever you typed, so it stays visible while the list filters — a static row is
  hidden exactly when you want it.
- **Bootstrap** — `Worktree: Bootstrap…`, or the `$(sync)` button on a switcher row. Re-runs the
  repo's `postCreate` hook against a worktree that already exists: the recovery path for a failed
  create, a failed delete, and worktrees made by agent tooling outside the editor. Offered only when
  the repo *has* a `postCreate` hook, and never on the primary worktree's row.
- **Picker contexts** — the switcher carries an inline strip of three toggles: worktrees (default,
  local, ~15 ms), Linear issues, and pull requests. `alt+1` / `alt+2` / `alt+3` switch while the
  picker holds focus, and each context is also its own command so it can be bound to open straight
  onto that tab. Only the worktrees context has a source behind it today.
- **Linear badge** — when a branch is named after a Linear issue, the status bar shows its
  identifier and the tooltip links to it. `Worktree: Open Linear Issue` opens it;
  `Worktree: Bind Linear Issue…` sets one by hand for a branch that carries none. No credentials
  and no network — the link is already in the branch name.
- **Per-repo hooks** — a repo can bind a command to run after a worktree is created and before one
  is deleted. See below.
- **Hook approvals** — `Worktree: List Hook Approvals` shows what you have approved;
  `Worktree: Forget Hook Approval…` revokes one.

## Per-repo hooks

The extension owns the *flow* — prompt, `git worktree add`, open. The repo owns the *bootstrap* —
env files, ports, containers, install/build. A repo binds two commands in its **tracked**
`.vscode/settings.json`, so they travel with the repo:

```json
{
  "worktreeManager.hooks.postCreate": "bun run worktree-hook post-create --apply",
  "worktreeManager.hooks.preDelete": "bun run worktree-hook pre-delete --apply"
}
```

| Setting | Effect |
|---|---|
| `worktreeManager.hooks.postCreate` | Runs after a worktree is created. Empty disables it. |
| `worktreeManager.hooks.preDelete` | Runs **before** deletion. **Non-zero aborts the delete.** Empty disables it. |
| `worktreeManager.worktreesRoot` | Where new worktrees go. Empty → `<parent of primary>/worktrees`. |

All three are **`window`** scope. `machine` scope cannot be set from `.vscode/settings.json`, which
is the entire point of binding per repo.

### The env contract

The hook is run from the **primary** worktree, and receives:

| Variable | Value |
|---|---|
| `WORKTREE_PATH` | Absolute path of the worktree being created or deleted |
| `WORKTREE_BRANCH` | Its branch |
| `WORKTREE_SOURCE` | The branch it was forked from, on create |
| `WORKTREE_PURPOSE` | `work` or `review` |

Context arrives as environment variables, never substituted into the command string. Branch names
come from free text and git forbids none of `` ` ``, `$`, `(`, `)`, `;`, `"` — interpolating them
into a shell line is a quoting bug waiting to happen.

### Why a non-zero exit aborts the delete

Because a failed teardown has to be able to stop the removal. If the stack will not come down, the
worktree must survive so you can retry; deleting first and discovering that second leaves nothing
to retry against. The hook runs as a programmatic `vscode.Task`, which yields a real exit code with
no dependency on shell integration. **A task that never reports an exit code is treated as a
failure** — the opposite would make a broken hook look like a successful teardown.

⚠️ Hooks run in VS Code's **automation profile**, not your interactive shell. `bun: command not
found` (exit 127) is the classic symptom.

### Trust

A hook is a shell command that a repo — and therefore a *branch* — controls. `gh pr checkout`
carries that branch's `.vscode/settings.json` into a folder you already trust, so Workspace Trust
does not cover this: it is granted once per parent folder, and every worktree already lives under
one you approved.

So the first run in a repo asks. The approval records the command, the folder it was resolved from,
the repo's `origin`, and a digest of the tracked `scripts/` tree. Any of those changing re-asks.

⚠️ **Approving a hook approves the repo's whole script tree at that commit**, not just the command
string. A branch that leaves the settings byte-identical and rewrites the script it calls is why
the tree digest is part of the key.

⚠️ **The hook inherits the extension host's environment.** `ShellExecutionOptions.env` is *merged*
with the parent environment — it cannot subtract — so `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` and
`DATABASE_URL` reach the hook if they reached VS Code. The trust approval is the only real
mitigation the API affords. A repo that wants isolation writes `env -i PATH="$PATH" …` into its own
command string, re-exporting by name; the extension cannot enforce that, because the command
belongs to the repo.

### Creating

| Step | Behaviour |
|---|---|
| Branch | Existing branch → checkout mode. New name → create mode, and you pick a source. |
| Already checked out | Refused up front, naming the worktree that holds it. |
| Destination | Defaults to `<worktreesRoot>/<branch basename>`. An existing path is rejected in the input box. |
| `postCreate` | Runs before the open prompt. A failure keeps the worktree and points at `Worktree: Bootstrap…`. |

⚠️ **A non-zero `git worktree add` does not mean nothing happened.** If the repo's `post-checkout`
hook fails, git exits 1 *having already created and registered the worktree* — and a fresh worktree
has no `node_modules`, so a repo whose hooks assert their own installation hits this routinely.
Rather than reporting the error and leaving an orphan you were never told about, the extension
re-reads `git worktree list` and offers **Continue anyway** or **Roll back**.

### Re-running the hook

⚠️ **A bootstrap is not a repair.** It rewrites the generated config a worktree owns — env files,
local tool config, seed data — and may reset its databases. Those files are gitignored, so a misclick
on the wrong row loses hand edits with no git recovery and no undo. It asks first, and it asks again
whether the worktree is for **work** or **review**, which is what supplies `WORKTREE_PURPOSE`.

It reports both outcomes. The hook's task panel opens without focus, so a silent failure would be
invisible — after the hook had already rewritten `.env`.

### The CLIs remain

Agent tooling creates worktrees outside the editor, and the extension cannot hook
`git worktree add` typed into a terminal. The repo's own scripts stay the primary interface for
scripted use.

## The picker

`ctrl+shift+w` is muscle memory and nearly every press is "switch to something I already have", for
which remote results are useless. Measured on this repo: `git worktree list --porcelain` takes
**11–17 ms**, `gh pr list` takes **454–537 ms**. Putting network calls in front of the common case
is a ~40× regression to serve the rare one, so the default context is local and instant and a
network context pays its cost only when selected.

Merging the three into one list fails for a second, independent reason: they are **not disjoint**.
6 of 10 worktree branches here are also an open PR head, and 27 of 35 PR heads carry a Linear id, so
one active ticket would occupy three rows. Contexts turn that from a dedup problem into a per-row
badge inside a single-source list.

### The Linear context

Lists the open issues assigned to you. A row carries `✓` when a worktree already exists for its
branch — selecting it switches — and `○` when one does not, where selecting it creates one with the
branch pre-filled.

The branch name is taken from Linear's `branchName` **verbatim** and never rebuilt from a slug: that
exact string is what Linear matches branches and PRs against, so regenerating it silently breaks the
link the whole feature depends on.

First paint comes from cache, so the context does not wait on the network, and a stale list says
`as of 12m ago` rather than pretending to be fresh. A failed refetch keeps the cached rows and says
so. An empty list is never used to mean "something went wrong" — a wrong credential says so in
words, because "no issues assigned to you" is a different claim.

⚠️ **The cache holds identifiers, titles, states and branch names — never issue bodies or
comments.** `globalState` is plaintext in `state.vscdb` and is shared across remote hosts at the same
repo path, and ticket bodies here carry personal data. A title is already visible in the
picker; a description is a different exposure. Signing out deletes the cache in the same act as the
credential.

⚠️ **No extension has shipped in-session QuickPick tabs**, so there is no reference implementation
and no worn path through the edge cases. If `alt+1/2/3` turns out not to fire — on macOS `alt` is
Option, and Option+digit emits a literal character — the strip's mouse toggles still work and each
context remains its own command, which is what every comparable extension does anyway.

⚠️ **A context key that gates an arrow-key binding must never be left set.** `pickerOpen` is
cleared in `onDidHide`, in a `finally`, and in `deactivate` — three sites, because the picker sets
no `ignoreFocusOut` and therefore hides on every ordinary focus loss, and because VS Code exposes no
read-back or reset API for context keys. Left set, it would steal the key workbench-wide with no way
for a user to discover which extension did it.

## Linear

Most worktrees here are already named after a Linear issue, because the branch name is copied from
Linear's own `branchName` rather than rebuilt from a slug. The link therefore already exists in the
data and needs no storage — it is simply never surfaced in the editor.

| Setting | Effect |
|---|---|
| `worktreeManager.linear.workspace` | Your workspace slug. **Required** — nothing in an identifier yields it, and team keys are unique only within a workspace. Empty disables every Linear feature. |
| `worktreeManager.linear.openIn` | `browser` (default) or `app` for `linear://` deep links. |
| `worktreeManager.linear.teamKeys` | e.g. `["A"]`. Optional but recommended — see below. |

A branch with no identifier degrades **in silence**, never with an error: the primary worktree
normally has none, so that is the common case rather than an exception.

### Signing in

`Worktree: Sign in to Linear` takes a **personal API key** (linear.app → Settings → Security &
access → Personal API keys). It is stored in `context.secrets`, never in `globalState` — the latter
is plaintext in `state.vscdb`.

⚠️ **`SecretStorage` does not sync across machines.** On a second machine Linear is simply
unconfigured until you sign in there too. That is by design, and it will otherwise read as a bug.

`Worktree: Sign out of Linear` deletes the key **and** every cache it filled, in one act. A
credential revoked while the ticket bodies it fetched stay on disk is the failure that matters here:
issue text in this workspace carries personal data.

### Moving an issue to started

`worktreeManager.linear.setStartedOnCreate` (default **off**) moves an issue to its team's first
started status when you create a worktree for it — after the `postCreate` hook exits 0, and before
the open prompt. A worktree whose bootstrap failed is not one you have started work in.

⚠️ **Only from `triage`, `backlog` or `unstarted`.** This workspace runs *two* started states,
In Progress and In Review, so an unguarded transition would drag an issue back from In Review every
time you create a worktree to address review comments — and would reopen a Done one.

⚠️ **Check whether Linear already does this for you before turning it on.** Linear has a
*Settings → Code & reviews* toggle that moves an issue to started when its branch name is copied
from the UI, and its GitHub integration has a "move to In Progress when a PR opens" default. If
either is active for your workspace, this setting duplicates a transition you already get — and the
rationale for a write-capable credential goes with it. That is one settings check, and it is worth
doing first.

It defaults to off for the same reason: a write-capable credential is not something a default
install should acquire on your behalf, and a grant already made cannot be narrowed by turning the
setting off afterwards.

📌 **OAuth is still the intended default, and is not built yet.** It gives revocation and no
long-lived credential at rest, which an API key does not. It is deferred because it rests on
`https://vscode.dev/redirect` forwarding an https callback to a *third-party* `vscode://` URI
handler — documented only for MCP server auth, with one hands-on report of it refusing a
non-Microsoft target. That needs a real round trip to settle, not a code change. Everything reads
its credential through one function, so OAuth drops in behind it without touching a caller. What
must never happen is an embedded client secret: a `.vsix` is a zip anyone can open.

⚠️ **Set `teamKeys` if you want the badge to be trustworthy.** The identifier pattern matches any
1–5 letters followed by a number, so a branch like `wip-2-something` or `fix-2-broken` produces a
confident-looking `WIP-2` badge linking to an issue that does not exist. Listing the keys your
workspace actually issues is what rejects those. Without it the match stays permissive.

## Requirements

**VS Code 1.109 or newer.** The `.vsix` refuses to install below it rather than installing and
throwing later, which is the honest failure — but it does mean a teammate on an older build is
excluded outright, not merely stale.

`@types/vscode` is pinned to the **exact** engine version, with no caret. A caret had silently
resolved 1.104 → 1.125, so post-floor APIs typechecked cleanly and would have thrown at runtime on
the version the manifest claimed to support. The pin makes the compiler enforce the floor; the
committed `bun.lock` and CI's `--frozen-lockfile` keep a local install from drifting away from it.

## Remote-SSH

Works unmodified. The manifest pins `extensionKind: ["workspace"]`, so it runs on the remote host
where git and the files are. `Uri.file()` is correct there and needs no special handling — the
RPC boundary rewrites outgoing `file://` URIs to `vscode-remote://` with the remote authority
before the workbench sees them, which is the same mechanism VS Code's own worktree commands rely
on.

`git worktree list --porcelain -z` needs **git ≥ 2.36**; older git rejects the switch outright
(exit 129). Since Ubuntu 22.04 ships 2.34 and Debian 11 ships 2.30, the reader falls back to the
newline format — verified to produce identical results. Any *other* git failure propagates and is
surfaced, rather than being swallowed into an empty list.

Pins, colours and the last-opened stamps live in `globalState`, which is stored on the **local**
machine and shared across remote hosts — but is partitioned per VS Code **profile**. Using a
dedicated profile for remote work gives you a separate set of colours.

## Deliberately not included

**Reading `tasks.json` instead of a settings string.** `${input:}` cannot be filled
programmatically, so the clicked row's path could never reach the task.

**A git `post-checkout` hook instead of an extension hook.** It would cover the CLI, this extension,
GitLens and the GitHub PR extension's worktree checkout all at once, which is genuinely better — and
it does not work here. A fresh worktree has no `node_modules`, therefore no hook-runner binary, and
a repo configured to *assert* its hook runner aborts rather than skipping.

**Subtracting variables from the hook's environment.** `ShellExecutionOptions.env` is merged with
the parent environment and cannot remove anything, so a "minimal env" would compile, read like a
mitigation, and do nothing. See the Trust section.

**Title bar colouring.** There is no API to colour a VS Code window — it can only be done by
persisting `workbench.colorCustomizations` to a settings file. Worse, with
`workbench.experimental.modernUI` enabled, VS Code ships

```css
.monaco-workbench.floating-panels .part.titlebar { background-color: transparent !important }
```

which no configuration layer can override ([microsoft/vscode#326126](https://github.com/microsoft/vscode/issues/326126)).
The same rule covers the activity bar and status bar *backgrounds*. Foregrounds are untouched —
which is exactly why the status bar item's colour works here.

## Develop

```bash
bun install
bun run dev          # incremental build
```

Then `F5` for the Extension Development Host.

⚠️ While developing the switcher, temporarily use `forceNewWindow: true` — `forceReuseWindow`
tears down the extension host **and** the debug session mid-call.

## Install locally (no marketplace, no .vsix)

`Developer: Install Extension from Location…` → point at this folder.

Dropping a folder into `~/.vscode/extensions/` has not worked since VS Code 1.75, despite what
the docs say — the registry `extensions.json` is authoritative.

### Updating and rolling back

There is no marketplace listing and therefore **no auto-update and no version pinning**. Updating is
re-running *Install Extension from Location…*; rolling back is checking out the older commit and
doing the same. Keep that in mind before relying on a behaviour that landed recently.

⚠️ **A teammate on an older build is not merely stale.** Once a repo binds `preDelete` in its
tracked `.vscode/settings.json`, everyone on that repo gets the setting — but only people who have
installed *this* extension get the hook. Anyone on an older build keeps running a bare
`git worktree remove` and orphans a stack per delete, with no signal that anything went wrong.
The setting cannot warn them, because the code that reads it is the code they do not have.

## Recovering by hand

The repo's own CLIs remain the primary interface for scripted use, and they are the fallback when
the editor path fails:

| Situation | Recovery |
|---|---|
| Create succeeded, hook failed | `Worktree: Bootstrap…`, or the repo's attach/bootstrap script |
| Delete aborted after teardown ran | `Worktree: Bootstrap…` to rebuild the stack, or delete it again |
| Worktree made outside the editor | `Worktree: Bootstrap…` — this is what it is for |
| Stack orphaned by a bare `git worktree remove` | the repo's orphan-reclaim command |
| Hook prompts you unexpectedly | `Worktree: List Hook Approvals` to see what is stored |

## Package

```bash
bun run package
```

⚠️ Never add a `vscode:prepublish` script — `vsce` invokes npm for it regardless of
`--no-dependencies`.
