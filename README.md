# Worktree Manager

Per-worktree identity and fast switching for git worktrees in VS Code.

## What it does (v0)

- **Status bar identity** — shows the current worktree's folder name in a colour derived from
  that name. Writes no settings file; `StatusBarItem.color` accepts a raw hex.
- **Switcher** — `ctrl+shift+w` opens a quick pick of every worktree in the repo and opens the
  chosen one **in the same window**. Pinned worktrees sort first.
- **Pins** — pin/unpin from the button on each quick pick row. Stored in `globalState`, keyed by
  the git admin directory name, which survives `git worktree move`.

Deliberately **not** in v0: title bar colouring (requires writing user settings), rename.
See the plan for the staging rationale.

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
