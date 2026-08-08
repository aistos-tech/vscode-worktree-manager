import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { readTrackedSettings } from "./jsonc";

export const HOOK_KEYS = {
  postCreate: "worktreeManager.hooks.postCreate",
  preDelete: "worktreeManager.hooks.preDelete",
} as const;

export type HookName = keyof typeof HOOK_KEYS;

const ROOT_KEY = "worktreeManager.worktreesRoot";

type ResolveHookProps = {
  hook: HookName;
  primaryPath: string;
};

export type ResolvedHook = {
  command: string;
  /* Which file the command came from. Part of the trust key: the same string arriving from a
     different folder is a different thing to approve. */
  source: string;
};

/* Resolution order is `getConfiguration` first, so user settings and profiles still layer, then
   the PRIMARY worktree's tracked settings.json.

   The fallback is the point, not a nicety. `.vscode/settings.json` is tracked, therefore
   branch-versioned: a worktree sitting on a branch older than the commit that added the hooks sees
   no hook at all, the runner resolves 0, and deleting it leaks the stack and its volumes silently
   — the exact bug this exists to fix, failing based on which window has focus. The gap is widest
   for ABANDONED worktrees, which are both the stalest and the ones whose stacks have squatted
   longest.

   `inspect()` rather than `get()` because an explicit "" is the documented way to disable a hook,
   and `get()` cannot tell that from unset — so the fallback would override a deliberate opt-out. */
export const resolveHook = ({ hook, primaryPath }: ResolveHookProps): ResolvedHook => {
  const key = HOOK_KEYS[hook];
  const inspected = vscode.workspace.getConfiguration().inspect<string>(key);
  const explicit =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  if (typeof explicit === "string") {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return { command: explicit.trim(), source: folder ?? primaryPath };
  }

  const tracked = readTrackedSettings(primaryPath)?.[key];
  return {
    command: typeof tracked === "string" ? tracked.trim() : "",
    source: primaryPath,
  };
};

/* Empty resolves to `<parent of primary>/worktrees`, which matches what the debt-collection CLI
   hardcodes. Configurable rather than assumed, because this ships to teammates whose layout is
   their own. */
export const resolveWorktreesRoot = (primaryPath: string) => {
  const configured = vscode.workspace.getConfiguration().get<string>(ROOT_KEY, "").trim();
  return configured || join(dirname(primaryPath), "worktrees");
};
