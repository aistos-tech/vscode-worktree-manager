# vscode-worktree-manager

## ⚠️ Nothing here may name a client — this repository is published

The source **and the full history** of this repo are public. Every commit is a publication.

**Nothing here may name a client, a customer engagement, or business context.** Not in code, not in
comments, not in documentation, and **not in commit messages** — a message is published exactly as a
file is, and it cannot be edited afterwards without rewriting history.

Fixtures use `acme` and `example`. Never a real branch name and never a concrete Linear workspace
slug. Three shapes leaked before and CI now rejects them: a fixture carrying a personal branch
prefix, an issue-id-slugged branch name (the form that binds a ticket to the work done on it), and a
workspace URL with a real slug rather than a `<placeholder>`. A test that asserts an identifier is
extracted does not care which identifier it is.

📌 A bare `A-1661` in a prompt or an error string is **fine** and is not a shape. It discloses a team
key and a number. Forbidding it would fire on every user-facing string that explains the feature,
which is how a guard trains people to ignore it.

📌 **The rule is about vocabulary, not about a list of forbidden words.** What this repo had to be
sanitised for was not a client's name in a config file. It was a branch fixture naming a product
rule, and a comment justifying a cache boundary by describing what kind of personal data the tickets
hold — ordinary phrasing, written without a thought, that tells a reader what the business does.
Reword such a rationale rather than deleting it: the design still needs its reason. When an example
needs a domain, invent one.

⚠️ **That includes this file.** An earlier draft of this very paragraph quoted the two offending
strings verbatim as illustrations, which would have published them under a heading announcing they
were sensitive.

`debt-collection` is allowed: it is an internal repo name, not a client, and it is what makes the
hook contract concrete.

⚠️ **The rule binds from the sanitising commit, not from the day the repo was flipped.** The flip is
the last step of the publish plan, and history goes public with the source — so a leak committed
while the repo was still private is published all the same. There was never a safe window.

A VS Code extension shown in the editor as **Aistos** — the repo, the package `name` and the
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

## Every `feat` bumps the minor, in the same commit

A `feat` raises the minor and a `fix` raises the patch, in `package.json`, **in the commit that
makes the change** — not in a release commit afterwards. `0.10.0` through `0.30.2` follow this
without exception; nothing enforces it, which is why it is written here.

⚠️ **The number is the only staleness signal there is.** This extension is installed by hand
through *Install Extension from Location…*, which copies the repo into
`~/.vscode/extensions/<id>-<version>/` — a snapshot, not a link. Ship a change without bumping and
the installed folder keeps its name, so a stale copy is indistinguishable from a current one and
nothing prompts a reinstall.

That is not hypothetical: `07d1db1` renamed every setting to `aistos.*` and left the version at
`0.30.2`. The installed `0.30.2` still declared `worktreeManager.*`, VS Code silently ignores
settings it does not recognise, and `debt-collection`'s pre-delete hook stopped firing — the exact
failure this extension exists to prevent, caused by a missed version bump rather than by any code.
