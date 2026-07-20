# Worktree Manager

Per-worktree identity and fast switching for git worktrees in VS Code.

## What it does (v0)

- **Status bar identity** — shows the current worktree's folder name in a colour derived from
  that name. Writes no settings file; `StatusBarItem.color` accepts a raw hex.
- **Switcher** — `ctrl+shift+w` opens a quick pick of every worktree in the repo and opens the
  chosen one **in the same window**. Pinned worktrees sort first.
- **Pins** — pin/unpin from the button on each quick pick row. Stored in `globalState`, keyed by
  the git admin directory name, which survives `git worktree move`.
- **Rename** — `Worktree: Rename…`, or the pencil button on any quick pick row. Runs
  `git worktree move`, then reopens the window if you renamed the one you're in. The VS Code
  title follows automatically, since the default `window.title` contains `${rootName}`.
  Pin and colour survive, because they key on the admin directory rather than the folder name.

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
