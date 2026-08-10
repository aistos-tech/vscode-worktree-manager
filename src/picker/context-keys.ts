import * as vscode from "vscode";

/* These gate arrow-key bindings at extension weight, which beats the built-in rules. A key left set
   after its surface closes therefore steals the key WORKBENCH-WIDE: RightArrow stops expanding
   folders in the Explorer, SCM and Search trees and instead fires against a disposed QuickPick.
   VS Code exposes no read-back, enumeration or reset API for context keys, so nothing in the UI can
   show which extension did it and the only recovery is Reload Window.

   And this is not a crash-only path: the picker sets no `ignoreFocusOut`, so it hides on every
   ordinary focus loss — clicking the editor, alt-tabbing, a notification arriving, the command
   palette opening over it.

   So: ONE owner. Nothing else in the codebase calls setContext for these two keys. */

export const PICKER_OPEN = "worktreeManager.pickerOpen";

/* There is no second key any more. The → preview is a MODAL, which VS Code owns and dismisses
   itself, so there is no surface of ours to gate a binding on and nothing that could be left set.
   The one key that remains is the one guarding an arrow key. */

const set = (key: string, value: boolean) =>
  vscode.commands.executeCommand("setContext", key, value);

/* Order matters, and it is counter-intuitive. `QuickInput.show()` first fires any OTHER input UI's
   onDidHide — so a key set BEFORE show() is immediately cleared by the handler that follows it.
   Set the incoming key after show(); clear the outgoing one before hide(). */
export const enterPicker = () => set(PICKER_OPEN, true);

export const exitPicker = () => set(PICKER_OPEN, false);

export const exitAll = () => exitPicker();
