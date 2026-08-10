import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/* `~` is a SHELL convention. Node expands nothing: `path.resolve("~/workspace/worktrees")` yields
   `<cwd>/~/workspace/worktrees`, and the extension host's cwd is `/`, so a perfectly ordinary
   setting produced `/~/workspace/worktrees` and `mkdirSync` failed with ENOENT. Measured 2026-08-10
   against `worktreeManager.worktreesRoot: "~/workspace/worktrees"` — the value anyone would write.

   Expanded here rather than at each call site, because the tilde can arrive from two directions:
   the `worktreesRoot` setting, and the destination the user types into the create prompt. */
export const expandHome = (input: string) => {
  const value = input.trim();
  if (value === "~") return homedir();
  /* Only a leading `~/`. A bare `~foo` is another user's home in shell convention, which Node
     cannot resolve and this must not guess at — and a `~` anywhere else is a legal filename
     character that would be corrupted by replacing it. */
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
};

/* The one place a user-supplied path becomes something to hand to the filesystem: expand the
   tilde first, then make it absolute. Order matters — `isAbsolute("~/x")` is false, so resolving
   before expanding is exactly the bug above. */
export const toAbsolutePath = (input: string) => {
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
};
