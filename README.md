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
- **Delete** — `Worktree: Delete…`, or the trash button on any quick pick row. Runs
  `git worktree remove` behind a modal confirmation; if the worktree holds modified **or
  untracked** files git refuses, and a second modal lists exactly what would be lost before
  offering `--force`. The branch is always kept. Deleting the worktree you're in reopens the
  window at the primary worktree. Pin and colour entries are released, so the palette slot is
  reusable.

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

## Package

```bash
bun run package
```

⚠️ Never add a `vscode:prepublish` script — `vsce` invokes npm for it regardless of
`--no-dependencies`.
