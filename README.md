# Aistos

Worktrees, Linear issues and pull requests in one switcher, with per-repo bootstrap hooks.

Shown in VS Code as **Aistos**; every command is under the `Aistos:` category in the palette.

📌 **The settings are `aistos.*`. The old `worktreeManager.*` keys are still read**, so an
unmigrated `.vscode/settings.json` keeps working. The extension *identifier* and the command ids
are still `worktreeManager`-based, and deliberately — see [Naming](#naming).

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
- **Rename** — `Aistos: Rename Worktree…`, or the pencil button on any quick pick row. Runs
  `git worktree move`, then reopens the window if you renamed the one you're in. The VS Code
  title follows automatically, since the default `window.title` contains `${rootName}`.
  Pin and colour survive, because they key on the admin directory rather than the folder name.
- **Delete** — `Aistos: Delete Worktree…`, or the trash button on any quick pick row. Runs the repo's
  `preDelete` hook if it has one, then `git worktree remove`, behind a modal confirmation that
  names the hook command. A **locked** worktree is refused before anything runs. A **prunable**
  one — directory already gone — offers to clear its git registration instead, since there is
  nothing left to tear down. Uncommitted changes are listed and consented to *before* the hook
  runs, not after git refuses. The branch is always kept. Deleting the worktree you're in reopens
  the window at the primary worktree. Pin and colour entries are released.
- **Create** — `Aistos: Create Worktree…`, or the `$(add)` row in the switcher. Prompts for a branch, a
  source to fork from (skipped when the branch already exists), and a destination, then runs the
  repo's `postCreate` hook and **opens the worktree**. The create row's label embeds whatever you
  typed, so it stays visible while the list filters — a static row is hidden exactly when you want
  it. `aistos.create.open` controls the ending: `sameWindow` (default), `newWindow`, `ask` — the
  behaviour before `0.38.0` — or `stay`.

  ⚠️ `sameWindow` reloads the window, which tears down the extension host, the hook's terminal and
  the Aistos log. Everything the bootstrap printed goes with it. That is why it runs only after a
  **successful** bootstrap — every failure path returns before the open — and why `newWindow` is
  the setting to pick if you want to read the output afterwards.
- **Bootstrap** — `Aistos: Bootstrap Worktree…`, or the `$(sync)` button on a switcher row. Re-runs the
  repo's `postCreate` hook against a worktree that already exists: the recovery path for a failed
  create, a failed delete, and worktrees made by agent tooling outside the editor. Offered only when
  the repo *has* a `postCreate` hook, and never on the primary worktree's row.
- **Picker contexts** — the switcher carries an inline strip of three toggles: worktrees (default,
  local, ~15 ms), Linear issues, and pull requests awaiting your review. `alt+1` / `alt+2` / `alt+3`
  switch while the picker holds focus, and each context is also its own command so it can be bound
  to open straight onto that tab.
- **Issue sidebar** — a panel in the Source Control view showing the **current** worktree's Linear
  issue: description and comments, rendered as markdown, with images. Refreshes on window focus and
  from the `$(refresh)` button. Appears only once `linear.workspace` is set.
- **Preview a row's issue (→)** — highlight any row in the picker and press **RightArrow**. The
  picker is replaced by a popup showing that branch's Linear issue; the platform Back binding
  (`ctrl+-` on macOS) or Escape returns you to the list with the same row still highlighted.
- **Linear badge** — when a branch is named after a Linear issue, the status bar shows its
  identifier and the tooltip links to it. `Aistos: Open Linear Issue` opens it;
  `Aistos: Bind Linear Issue…` sets one by hand for a branch that carries none. No credentials
  and no network — the link is already in the branch name.
- **Per-repo hooks** — a repo can bind a command to run after a worktree is created and before one
  is deleted. See below.
- **Hook approvals** — `Aistos: List Hook Approvals` shows what you have approved;
  `Aistos: Forget Hook Approval…` revokes one.
- **Logs** — `Aistos: Show Logs` opens the extension's output channel. Failures also raise a toast
  with a **Show Logs** button, so a flow that dies no longer dies quietly.

## Per-repo hooks

The extension owns the *flow* — prompt, `git worktree add`, open. The repo owns the *bootstrap* —
env files, ports, containers, install/build. A repo binds two commands in its **tracked**
`.vscode/settings.json`, so they travel with the repo:

```json
{
  "aistos.hooks.postCreate": "bun run worktree-hook post-create --apply",
  "aistos.hooks.preDelete": "bun run worktree-hook pre-delete --apply"
}
```

| Setting | Effect |
|---|---|
| `aistos.hooks.postCreate` | Runs after a worktree is created. Empty disables it. |
| `aistos.hooks.preDelete` | Runs **before** deletion. **Non-zero aborts the delete.** Empty disables it. |
| `aistos.worktreesRoot` | Where new worktrees go. Empty → `<parent of primary>/worktrees`. `~` is expanded. |

⚠️ **`~` is expanded here and in the destination prompt, and it did not used to be.** `~` is a
*shell* convention — Node expands nothing, and `path.resolve("~/workspace/worktrees")` returns
`<cwd>/~/workspace/worktrees`. The extension host's cwd is `/`, so the entirely reasonable setting
`"~/workspace/worktrees"` reached `mkdirSync` as `/~/workspace/worktrees` and died with `ENOENT`.
Fixed in `0.34.0`; before that the failure was also silent, which is a separate story under
[Logs](#logs).

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

Hooks run in **`$SHELL -lc`** — a login shell, so your profile is sourced and anything `mise`,
`asdf` or `nvm` puts on the PATH is there.

⚠️ **This changed in `0.39.0`.** Before that they ran through a `ShellExecution` in VS Code's
**automation profile**, which sources no profile, and `bun: command not found` (exit 127) was the
classic symptom. The extension now spawns the process itself, so it picks the shell — see
[Live hook output](#live-hook-output) for why it spawns at all.

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

**The prompt is a quick pick step, not a modal**, since `0.37.0`. It appears in the same sequence
as branch → source → destination, with two rows and the command in the placeholder. A modal took
over the window, centred itself, and rendered its detail as a wall of grey text in the middle of a
flow made of quick picks — and the paragraph above lived inside it, re-read on every re-ask until
nobody read any of it. It is documented here once instead. The gate itself is unchanged: same
fingerprint, same storage, same refusal semantics on the delete path.

💡 **If it re-asks more often than you expect, the `scripts/` digest is why** — in a repo where
`scripts/` changes weekly, so does the prompt. That is the cost of covering the
rewrite-the-script-without-touching-settings case, and it is a deliberate trade rather than a bug.

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
| `postCreate` | Runs before the open prompt. A failure keeps the worktree and points at `Aistos: Bootstrap Worktree…`. |

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

Lists the open issues assigned to you, **the ones you already have a worktree for first**, under a
`Not checked out` separator. The point of the context is to get you into work, and the cheapest
version of that is switching to something that already exists — a list that interleaves the three
you can switch to with the twenty you would have to create buries the cheap action inside the
expensive one. Within each group the server's order is preserved (Linear by `updatedAt`).

A row carries `✓` when a worktree already exists for its branch — selecting it switches — and `○`
when one does not, where selecting it creates one with the branch pre-filled.

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

### The pull request context

Lists what is **waiting on your review**, not every open PR — and, like the Linear context, the ones
you already have a worktree for come first. Measured on this repo:
`review-requested:@me` returns 3, all open PRs returns 35 — most of them your own, which is a
scrolling exercise rather than a queue.

GitHub authentication is free: `'github'` is a built-in provider id, so there is no extension
dependency, no client secret, no URI handler and no refresh handling. `Aistos: Sign in to GitHub`
if you have not already.

`✓` switches to the worktree you already have for that PR's branch; `○` **creates one**, with the
branch pre-filled — the same two behaviours as the Linear tab, on purpose. A row that did something
different depending on which tab you were looking at is a rule to remember rather than a tool to
use.

⚠️ This was read-only until `0.31.0`: `○` opened the PR in a browser, on the argument that the
GitHub Pull Requests extension already ships "Checkout Pull Request in Worktree" and duplicating it
was not worth it. That traded the common action for the rare one. Reaching the PR page costs one
keystroke either way — **RightArrow** previews it and the preview's `Open PR` action still opens
the URL.

**A PR row creates for `review`, not `work`** — the one place the two tabs genuinely differ, and
the reason is the bootstrap rather than the picker. The hook receives
`WORKTREE_PURPOSE=review`, and the repo decides what that skips: debt-collection drops the
containers, the Postgres wait and the database seeding, which is the slow half. A PR is a branch
you are about to read and delete, so spending minutes on a stack you will not start is a poor
trade. A Linear row stays `work` — an issue you are picking up is work by definition.

`aistos.hooks.purpose` overrides it: `auto` (default) is the per-tab rule above, `work` and
`review` pin it regardless of tab.

The reason this context exists at all, given that extension also lists PRs, is the **join**: it
renders PRs in its own sidebar, unaware of worktrees, so it cannot tell you that `#404` is the
worktree you already have open, or switch you to it.

⚠️ **No extension has shipped in-session QuickPick tabs**, so there is no reference implementation
and no worn path through the edge cases. If the keybindings turn out not to fire, the strip's mouse
toggles still work and each context remains its own command, which is what every comparable
extension does anyway.

📌 **On `tab`.** Tab in a quick input also moves DOM focus between the filter box and the list, so
binding it is a genuine trade — but it *is* dispatched through the normal keybinding layer (VS Code
binds Tab itself for snippets and suggestions, and quick-open ships its own Tab-family cycling at
weight 250 with a `when` clause). Extension bindings register at weight 400, so ours wins where its
`when` matches, and a matched binding suppresses the default focus move.

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
| `aistos.linear.workspace` | Your workspace slug. **Required** — nothing in an identifier yields it, and team keys are unique only within a workspace. Empty disables every Linear feature. |
| `aistos.linear.openIn` | `browser` (default) or `app` for `linear://` deep links. |
| `aistos.linear.teamKeys` | e.g. `["A"]`. Optional but recommended — see below. |

A branch with no identifier degrades **in silence**, never with an error: the primary worktree
normally has none, so that is the common case rather than an exception.

### Signing in

Two ways, and which one you get depends on whether `aistos.linear.clientId` is set.

**OAuth (preferred).** Create an app at `linear.app/settings/api/applications/new`, register the
redirect URI as **exactly** `http://127.0.0.1:47823/callback`, and put its client id in the setting.
`Aistos: Sign in to Linear` then opens your browser, and signing out actually **revokes** the
authorisation at Linear rather than just forgetting it locally.

There is no client *secret* to configure. PKCE makes one unnecessary, and a `.vsix` is a zip anyone
can open, so the extension could not safely hold one anyway.

**Personal API key.** Leave the client id empty and sign-in *asks which you want* — a key now, or
help setting up OAuth (it opens the app-registration page and the setting, and tells you the exact
redirect URI to paste). This is not a degraded mode: OAuth needs an app registered in the workspace,
which is a step you may reasonably not want to take.

Either way the credential lives in `context.secrets`, never in `globalState`, which is plaintext in
`state.vscdb`.

📌 **Why a loopback callback rather than `vscode://`.** Linear's own OAuth docs use
`http://localhost:3000/oauth/callback` as their redirect example, so the ordinary native-app flow
(RFC 8252) applies: the extension listens on a fixed loopback port for the length of the sign-in and
closes it immediately afterwards. The alternative — a `vscode://` callback bounced through
`https://vscode.dev/redirect` — is documented only for MCP server auth and has been reported
refusing non-Microsoft targets, so it is a dependency worth not having.

⚠️ **Remote-SSH is the case to test.** The extension runs on the remote host, so the callback server
does too. `asExternalUri` establishes VS Code's port forwarding, but if the forwarded local port is
not 47823 the redirect will not match what Linear has registered. The API key path works
unconditionally and is the fallback if that bites.

⚠️ **Scopes follow the setting, not the install.** Sign-in requests `read` only, unless you have
enabled `setStartedOnCreate`, in which case it requests `write` too. A grant already made cannot be
narrowed by turning the setting off later, so enabling it re-asks rather than being requested up
front.

⚠️ **`SecretStorage` does not sync across machines.** On a second machine Linear is simply
unconfigured until you sign in there too. That is by design, and it will otherwise read as a bug.

`Aistos: Sign out of Linear` deletes the key **and** every cache it filled, in one act. A
credential revoked while the ticket bodies it fetched stay on disk is the failure that matters here:
issue text in this workspace carries personal data.

### Moving an issue to started

`aistos.linear.setStartedOnCreate` (default **off**) moves an issue to its team's first
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

📌 Everything reads its credential through one function, so the two mechanisms above cost the rest
of the extension nothing.

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

### The issue sidebar

It has its **own icon in the activity bar**, below Extensions.

⚠️ **The icon only appears once `aistos.linear.workspace` is set** — the view's `when`
clause is that setting, and a container with no visible views is hidden, so with it empty there is
nothing to find. `Aistos: Show Linear Issue Panel` is the way in: it focuses the panel, or tells you
what to configure if that is why it is missing.

A `WebviewView` in the Source Control container, showing the ticket for the worktree you are **in** —
which is what distinguishes it from `→`, which shows whichever row you are pointing at. Description
and comments both, because a ticket's decisions accumulate in its comments and rendering only the
description shows the stalest part of it.

Markdown is rendered by **VS Code's own renderer**, through the `markdown.api.render` command the
built-in markdown extension exposes. So ticket bodies look exactly like a markdown preview, including
any markdown-it plugins you have installed — and the extension bundles no markdown parser, which
keeps it dependency-free.

⚠️ That command is not in the extension-authoring guide, so it is treated as semi-public: if it ever
disappears, the panel falls back to escaped plain text rather than breaking.

Images load **directly from Linear**, using signed URLs: the GraphQL request sets
`public-file-urls-expire-in`, and every file URL in the response comes back with a signature that
works without an `Authorization` header. Nothing is cached on disk — no image cache, no
`localResourceRoots`, no retention policy, and no ticket data at rest to leak. The panel refetches
on focus, which remints the signatures.

⚠️ **The CSP is the sanitiser, and it has to be.** Markdown permits raw HTML and a ticket body is
text written by anyone with workspace access. `default-src 'none'` with `script-src 'none'` means an
injected `<script>` or `onerror=` cannot execute even though it survives rendering, and `img-src` is
narrowed to Linear's own storage rather than opened to `https:`, so a body cannot beacon out by
embedding a remote image.

### Previewing a row

**→** on any picker row opens the same popup, from any context — a row means the same thing wherever
you reached it from: a unit of work that may have a worktree, a Linear issue and a pull request.
Showing a different subset per tab would make the gesture's result depend on where you came from.

It is a **webview panel** using the **same renderer as the sidebar** — the same markdown, the same
CSP, the same images. It scrolls, so nothing is truncated: full description, full comment thread.

```
┌─ ACME-42 ───────────────────────────────────┐
│ ACME-42                                     │
│ Import mapping for the onboarding flow      │
│ [In Progress] Léa · PR #421 open            │
│                                             │
│ Le fichier d'import arrive avec des         │
│ colonnes déjà partiellement normalisées…    │
│  ☑ mapping des colonnes du CSV              │
│  ☐ règle de rapprochement                   │
│  ┌───────────────────┐                      │
│  │  screenshot.png   │   ← real image       │
│  └───────────────────┘                      │
│  ── 3 comments ──                           │
│  Léa · 2d   On garde le scope import pour…  │  ↕ scrolls
├─────────────────────────────────────────────┤
│ [Open worktree O] [Open in Linear L] [PR P] │  ← footer
└─────────────────────────────────────────────┘
```

**Shortcuts are printed on the buttons.** `O` open worktree, `C` create worktree, `L` Linear, `P`
the PR, `Escape` closes and returns you to the picker with the same row still highlighted. They are
handled inside the page rather than as VS Code keybindings, because a webview holds focus while it
is open and a `when`-scoped binding would need a context key per panel for no gain.

It opens as a **new tab in the column you were already in**, not on top of the file you were
reading and not in a split. The picker's job is to move you somewhere, and replacing the file you
had open in order to preview a ticket is a poor trade — but so is a split.

⚠️ It used `ViewColumn.Beside` until `0.31.0`. A split is a *layout* change and it outlives the
preview: the panel closes on the first action and leaves a second column you never asked for and
have to close by hand. A tab disappears with the panel and leaves the layout exactly as it was,
while still keeping the file you were reading one tab to the left.

📌 **This replaced a native modal.** A modal's body is plain text by API — no markdown, no images,
no links — so ticket content had to be flattened into an approximation and then truncated to stop
the dialog outgrowing the screen. Two surfaces rendering the same ticket two different ways is the
kind of difference nobody notices until it matters, so there is now one renderer and both use it.


⚠️ **All issue-derived text is escaped before it reaches a row.** `$(name)` renders as a theme icon
in a row's `label`, `description` *and* `detail`, so a ticket titled `run $(bun test)` would
otherwise be swallowed or drawn as a broken glyph.

📌 `→` is inert in an extension's QuickPick by default — its only binding, `acceptInBackground`, is
gated on a flag extensions cannot set — so claiming the key displaces nothing. The `when` clause
reuses VS Code's own cursor guard, so the key still moves the cursor when you are mid-filter.

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

## Not built yet

Two pieces of the plan this implements are deliberately outstanding, both blocked on something a
code change cannot settle.

## Keybindings

| Key | Command | When |
|---|---|---|
| `ctrl+shift+w` | Open the switcher | always |
| `tab` / `shift+tab` | Cycle to the next / previous context | the picker is open |
| `alt+1` / `alt+2` / `alt+3` | Jump straight to Worktrees / Linear / Pull requests | the picker is open |
| `→` | Preview the highlighted row | the **picker** is open, cursor at end of the filter |
| `escape` | Close the preview, back to the list | the preview panel has focus |
| `o` `c` `l` `p` | Preview actions — open / create worktree, Linear, PR | the preview panel has focus |

⚠️ `→` and `alt+1/2/3` fire only while a picker of this extension holds focus, and the `→` clause
additionally reuses two of VS Code's **internal** context keys (`inputFocus`,
`cursorAtEndOfQuickInputBox`). They are usable in a `when` clause but are not API: if either is
renamed, `→` starts firing mid-word in the filter box. Degraded, not broken — and worth re-checking
after a VS Code upgrade.

## Naming

The extension displays as **Aistos**, its commands sit under the `Aistos:` category, and its
settings live under the `aistos` root key. Two things did **not** change, each for a reason worth
stating:

| Unchanged | Why |
|---|---|
| `name` (and so the extension id `aistos-tech.vscode-worktree-manager`) | VS Code keys `globalState` and `SecretStorage` by extension id. Changing it discards your Linear session, every hook trust approval, the pin colours and both caches — and leaves the old extension installed alongside the new one, contributing a duplicate of every command and keybinding. |
| `worktreeManager.*` command ids | Anything a teammate has bound in `keybindings.json` keeps working. |

The **setting keys** did change, from `worktreeManager.*` to `aistos.*`. They are the repo↔editor
contract — `debt-collection/.vscode/settings.json` binds the pre-delete hook, and VS Code silently
ignores settings it does not recognise, so a bare rename would stop that hook firing for every
teammate with no error, and each delete would go back to orphaning a stack. It therefore ships as a
migration rather than an edit:

- Every read tries `aistos.<key>` first, then `worktreeManager.<key>` — in `getConfiguration` **and**
  in the primary worktree's tracked `.vscode/settings.json`, which is branch-versioned and so lags
  behind on any branch older than the rename.
- The manifest still declares the old keys, marked deprecated, so the editor explains the move
  rather than greying them out as unknown.
- The fallback goes away in a later release, not in this one.

Renaming the id or the command ids is possible too, but each is a migration of the same shape — ask
if you want one.

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
bun run hooks        # once per clone — pre-commit guard, see below
bun run dev          # incremental build
```

Then `F5` for the Extension Development Host.

⚠️ **`bun run hooks` is a separate step because `bun install` does not run `prepare`.** Measured on
bun 1.3.14: wiring the hook to that lifecycle script would have installed nothing, silently. The
hook rejects a fixture naming a real branch, a personal branch prefix or a real Linear workspace —
this repo is public, so a push is a publication. Client names themselves are checked in CI, against
a list that cannot live in a public repo. A commit that *removes* one of these still contains it in
its own diff, so sanitising commits use `--no-verify`.

⚠️ While developing the switcher, temporarily use `forceNewWindow: true` — `forceReuseWindow`
tears down the extension host **and** the debug session mid-call.

## Install

No clone, no `bun install`, no build:

```bash
curl -fsSLO https://github.com/aistos-tech/vscode-worktree-manager/releases/latest/download/aistos.vsix \
  && code --install-extension aistos.vsix --force \
  && rm aistos.vsix
```

`--force` because `code` no-ops when the same version is already installed. `aistos.vsix` is a
fixed asset name published alongside the versioned one, which is what makes
`releases/latest/download/…` a stable URL — that path resolves a *name*, so a versioned asset alone
could not be fetched without first asking the API which version is current.

⚠️ **`code` is not on `PATH` on a fresh macOS install.** Command Palette →
*Shell Command: Install 'code' command in PATH*.

Releases are built by CI on every version bump. There is no marketplace listing, so nothing installs
this for you and nothing signs it.

### Updating and rolling back

Updating is re-running the install command above — `latest` resolves to the newest release, and
`--force` replaces what you have. **Nothing tells you a new version exists yet**; that is what
`Aistos: Update…` is for, and it is not built.

Rolling back means downloading an older release asset and installing that:

```bash
gh release download v0.38.0 -R aistos-tech/vscode-worktree-manager -p '*.vsix'
code --install-extension vscode-worktree-manager-0.38.0.vsix --force
```

⚠️ **A teammate on an older build is not merely stale.** Once a repo binds `preDelete` in its
tracked `.vscode/settings.json`, everyone on that repo gets the setting — but only people who have
installed *this* extension get the hook. Anyone on an older build keeps running a bare
`git worktree remove` and orphans a stack per delete, with no signal that anything went wrong.
The setting cannot warn them, because the code that reads it is the code they do not have.

### From a clone, for development

`Developer: Install Extension from Location…` → point at this folder. Still the right path when you
are changing the extension, since it needs no release.

Dropping a folder into `~/.vscode/extensions/` has not worked since VS Code 1.75, despite what
the docs say — the registry `extensions.json` is authoritative.

## Recovering by hand

The repo's own CLIs remain the primary interface for scripted use, and they are the fallback when
the editor path fails:

| Situation | Recovery |
|---|---|
| Create succeeded, hook failed | `Aistos: Bootstrap Worktree…`, or the repo's attach/bootstrap script |
| Delete aborted after teardown ran | `Aistos: Bootstrap Worktree…` to rebuild the stack, or delete it again |
| Worktree made outside the editor | `Aistos: Bootstrap Worktree…` — this is what it is for |
| Stack orphaned by a bare `git worktree remove` | the repo's orphan-reclaim command |
| Hook prompts you unexpectedly | `Aistos: List Hook Approvals` to see what is stored |
| **Nothing happens at all** | `Aistos: Show Logs` — see below |

### Live hook output

A create, a bootstrap and a delete each show a **progress notification whose message is the last
line the hook printed**. The same lines go to the log channel, so the transcript outlives the
notification and the terminal.

⚠️ **Getting that required changing who runs the hook.** It used to run as a `ShellExecution`,
which VS Code executes in a terminal *it* owns — and an extension cannot read the output of a
terminal it did not create. The Pseudoterminal API is explicit about that. So the output existed
only on screen, in a panel opened with `focus: false`, and the log could record the exit code and
nothing else. A create looked frozen for minutes.

It is now a `CustomExecution` returning a **`Pseudoterminal` the extension implements**, which
spawns the process itself. It is still a real `vscode.Task` — same panel, same task list, same
re-run — but the stream belongs to the extension, so it reaches the terminal, the log and the
notification at once.

Two things that fell out of owning the process:

- The shell is now `$SHELL -lc`, which fixes the `exit 127` class described under
  [Per-repo hooks](#per-repo-hooks).
- The environment **could** now be filtered. `ShellExecutionOptions.env` could only merge, never
  subtract, which is why the note below says the trust approval is the only mitigation. That is
  still true today — the hook still inherits everything — but it is now a decision rather than a
  constraint.

### Logs

`Aistos: Show Logs` opens the **Aistos** output channel. It is a `LogOutputChannel`, so
*Developer: Set Log Level…* → `Trace` turns on the per-step detail and the default level stays
quiet.

⚠️ **There was no log surface at all before `0.33.0`, and that was a real defect rather than a
missing nicety.** Every flow the picker starts runs as fire-and-forget — the picker disposes, the
work continues without anything awaiting it — so a rejection anywhere in it was swallowed by the
extension host. No dialog, no output, no trace. `Enter` on a PR row that failed produced *nothing*,
and "nothing happened" was the entire bug report available.

Those launches now go through a wrapper that cannot swallow a rejection: it logs the stack and
raises a toast naming the operation, with a **Show Logs** button on it. So a failure announces
itself whether or not the channel is open.

What gets traced, at `Trace`/`Debug` level:

| Boundary | Line |
|---|---|
| every git call | `git worktree add … — ok in 34ms (cwd …)`, or `— FAILED exit=128 …` with git's stderr |
| every hook run | `hook "postCreate" finished — exit=0: bun run worktree-hook …` |
| GitHub / Linear | the HTTP status of each query |
| the picker | which row kind was accepted, its branch, and whether a local worktree matched |

⚠️ **Every git call goes through one wrapper, and nothing in `worktree.ts` calls `execFile`
directly.** Eleven call sites is eleven chances to add a twelfth without logging, and the one that
matters is always the one nobody instrumented. A git failure a caller deliberately swallows —
`branchExistsAnywhere` turns one into `false` on purpose — still leaves a line.

`worktree.ts` writes through a callback rather than importing the log channel, because it must stay
free of `vscode`: `bun test` cannot import a module that imports `vscode`, and the porcelain
parsing in there is the code most worth proving. `src/trace.ts` is that seam, and `initLog`
installs the real sink.

## Package

```bash
bun run package
```

⚠️ Never add a `vscode:prepublish` script — `vsce` invokes npm for it regardless of
`--no-dependencies`.
