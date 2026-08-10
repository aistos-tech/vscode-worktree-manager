import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { readTrackedSettings } from "./jsonc";
import { expandHome } from "./paths";
import { explicitSetting, legacyKey, setting } from "./settings";

export const HOOK_KEYS = {
  postCreate: "aistos.hooks.postCreate",
  preDelete: "aistos.hooks.preDelete",
} as const;

export type HookName = keyof typeof HOOK_KEYS;

const ROOT_KEY = "aistos.worktreesRoot";

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
  const explicit = explicitSetting<string>(key) ?? explicitSetting<string>(legacyKey(key));
  if (typeof explicit === "string") {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return { command: explicit.trim(), source: folder ?? primaryPath };
  }

  const settings = readTrackedSettings(primaryPath);
  const tracked = settings?.[key] ?? settings?.[legacyKey(key)];
  return {
    command: typeof tracked === "string" ? tracked.trim() : "",
    source: primaryPath,
  };
};

/* Empty resolves to `<parent of primary>/worktrees`, which matches what the debt-collection CLI
   hardcodes. Configurable rather than assumed, because this ships to teammates whose layout is
   their own. */
/* ⚠️ `expandHome`, not the raw value. `~` is a shell convention and Node expands nothing, so
   `worktreesRoot: "~/workspace/worktrees"` — the value anyone would write — reached `mkdirSync` as
   `/~/workspace/worktrees` and failed with ENOENT. The setting is `window`-scoped and therefore
   hand-written, which makes a tilde the expected input rather than an edge case. */
export const resolveWorktreesRoot = (primaryPath: string) => {
  const configured = expandHome(setting(ROOT_KEY, ""));
  return configured || join(dirname(primaryPath), "worktrees");
};
