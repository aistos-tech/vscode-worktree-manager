import * as vscode from "vscode";

/* The setting keys moved from `worktreeManager.*` to `aistos.*` when the extension took the Aistos
   name. Every read goes through here, and every read tries the old key second.

   The fallback is not politeness. `.vscode/settings.json` is tracked, therefore branch-versioned:
   a teammate on a branch older than the commit that renames the keys would otherwise get no
   pre-delete hook at all, with no error, and each delete would go back to orphaning a stack — the
   exact failure this extension exists to prevent. The manifest still declares the old keys, marked
   deprecated, so the editor explains the move rather than greying them out as unknown. */
export const legacyKey = (key: string) => key.replace(/^aistos\./, "worktreeManager.");

/* `inspect` rather than `get` because an explicit "" is the documented way to disable a hook, and
   `get` cannot tell that from unset — so the legacy key would override a deliberate opt-out. */
export const explicitSetting = <T>(key: string) => {
  const inspected = vscode.workspace.getConfiguration().inspect<T>(key);
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
};

export const setting = <T>(key: string, fallback: T) =>
  explicitSetting<T>(key) ?? explicitSetting<T>(legacyKey(key)) ?? fallback;

export const settingChanged = (event: vscode.ConfigurationChangeEvent, key: string) =>
  event.affectsConfiguration(key) || event.affectsConfiguration(legacyKey(key));
