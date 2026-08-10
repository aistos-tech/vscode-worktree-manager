# vscode-worktree-manager

A private VS Code extension shown in the editor as **Aistos** — the repo, the package `name` and the
extension id all keep `vscode-worktree-manager`, and so do the `worktreeManager.*` command ids. The
**settings** are `aistos.*`, with the old keys still read as a deprecated alias — every read goes
through `src/settings.ts`, never `getConfiguration().get` directly. `README.md` → *Naming* says why
each of those is what it is, and the reasons are load-bearing rather than cosmetic. It switches between git worktrees. `src/` splits along the seams the
plan named: `worktree.ts` (porcelain parsing, identity, the git calls), `state.ts` (`globalState` —
colours, pins, recency), `manage.ts` (rename and delete), `extension.ts` (activation, status bar,
switcher). `private: true`, never published — installed by hand through
*Install Extension from Location…*.

## Standards come from the shared plugin

Engineering conventions — arrow functions, no `any`, no `as`, `import type`, Zod for runtime
validation, the conventional-commit format — live in `aistos-dev`, installed via
`.claude/settings.json`. They are not restated here. If something is true for Aistos code in
general, fix it in `aistos-tech/claude-standards` so every repo gets it, rather than here.

## The traps are in the README, not here

`README.md` is this repo's product surface — no marketplace listing, so it is the only description
a teammate gets. It already documents `extensionKind: ["workspace"]` and why Remote-SSH works, the
`vscode:prepublish` ban, and the `forceReuseWindow` extension-host teardown. **Read it before
changing packaging, the switcher, or the manifest.** Restating those here would give them two homes
and one would drift.

One fact has no home there, because it is invisible to a user:

- **`engines.vscode` and `@types/vscode` move together** — `^1.109.0` and an **exact** `1.109.0`
  today. The types package is the compile-time shape of the API; `engines` is the runtime floor.
  Bumping types alone compiles against an API the declared minimum does not have, and it fails on a
  user's machine rather than in CI, which typechecks against the same wrong pair.

  The devDependency is pinned without a caret, and that is deliberate: `^1.104.0` had silently
  resolved to **1.125.0**, so twenty-one versions of API were compiling cleanly against a declared
  floor that did not have them. An exact pin makes the compiler enforce the floor instead of merely
  documenting it, and the committed `bun.lock` plus CI's `--frozen-lockfile` is the second
  enforcement point. Raise both together, in one commit, or not at all.

## Changing what the extension offers

`contributes.commands` and `contributes.keybindings` are the product. A change to either changes
`README.md` in the same PR — CI enforces it, and it fires on the `contributes` block alone, so a
version bump or a devDependency does not demand a docs edit.
