import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";
import { forgetWorktree } from "./state";
import {
  describeDirt,
  moveWorktree,
  pruneWorktrees,
  removeWorktreeAt,
  stderrOf,
  type Worktree,
} from "./worktree";

type ValidateNameProps = {
  value: string;
  currentName: string;
  parent: string;
};

export const validateName = ({ value, currentName, parent }: ValidateNameProps) => {
  const trimmed = value.trim();
  if (!trimmed) return "Name cannot be empty.";
  if (trimmed === currentName) return undefined;
  if (/[/\\]/.test(trimmed)) return "Name cannot contain a path separator.";
  if (trimmed === "." || trimmed === "..") return "Invalid name.";
  if (existsSync(join(parent, trimmed))) return `"${trimmed}" already exists.`;
  return undefined;
};

type RenameWorktreeProps = {
  worktree: Worktree;
  isCurrent: boolean;
  gitCwd: string;
};

/* WHY: git refuses to move the main worktree, and refuses again on a locked one or with
   submodules — its stderr is the useful message, so surface it verbatim rather than guessing. */
export const renameWorktree = async ({ worktree, isCurrent, gitCwd }: RenameWorktreeProps) => {
  if (worktree.isMain) {
    vscode.window.showErrorMessage(
      "Cannot rename the primary worktree — git worktree move refuses to move it.",
    );
    return;
  }

  const currentName = basename(worktree.path);
  const parent = dirname(worktree.path);
  const newName = await vscode.window.showInputBox({
    title: `Rename worktree "${currentName}"`,
    value: currentName,
    valueSelection: [0, currentName.length],
    prompt: "Renames the folder on disk. Terminal panes sitting in it keep the old path.",
    validateInput: (value) => validateName({ value, currentName, parent }),
  });

  const trimmed = newName?.trim();
  if (!trimmed || trimmed === currentName) return;

  const target = join(parent, trimmed);
  try {
    await moveWorktree({ from: worktree.path, to: target, gitCwd });
  } catch (error) {
    vscode.window.showErrorMessage(`git worktree move failed — ${stderrOf(error)}`);
    return;
  }

  if (!isCurrent) {
    vscode.window.showInformationMessage(`Renamed "${currentName}" to "${trimmed}".`);
    return;
  }

  /* WHY: openFolder tears down the extension host — nothing after it runs, and the old path
     is already stale, so this must be the last statement. */
  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), {
    forceReuseWindow: true,
  });
};

type DeleteWorktreeProps = {
  context: vscode.ExtensionContext;
  worktree: Worktree;
  isCurrent: boolean;
  gitCwd: string;
  mainPath: string;
};

export const deleteWorktree = async ({
  context,
  worktree,
  isCurrent,
  gitCwd,
  mainPath,
}: DeleteWorktreeProps) => {
  if (worktree.isMain) {
    vscode.window.showErrorMessage("Cannot delete the primary worktree.");
    return;
  }

  const name = basename(worktree.path);

  /* WHY: refuse before anything else. A locked worktree is one somebody deliberately marked as in
     use; git would refuse the removal anyway, but only after the confirmation modal has already
     been answered — and this flow is about to gain a teardown hook that must never run against a
     worktree the removal will not go through on. */
  if (worktree.locked) {
    vscode.window.showErrorMessage(
      `"${name}" is locked${worktree.lockReason ? ` — ${worktree.lockReason}` : ""}. ` +
        "Unlock it with `git worktree unlock` if you really mean to remove it.",
    );
    return;
  }

  /* WHY: a prunable worktree's directory is already gone. There is nothing to check for
     uncommitted changes and nothing for a teardown hook to run against, so the hard refusal used
     for `locked` would only strand the row in the switcher with no in-editor way to clear it.
     Clear the registration instead, and say plainly that whatever it was running outlives it. */
  if (worktree.prunable) {
    const cleared = await vscode.window.showWarningMessage(
      `"${name}" is already gone from disk. Clear its registration?`,
      {
        modal: true,
        detail:
          `${worktree.path}\n\nOnly the git registration is removed. Anything the worktree was ` +
          "running — containers, volumes — outlives it and has to be reclaimed separately.",
      },
      "Clear registration",
    );
    if (cleared !== "Clear registration") return;
    try {
      await pruneWorktrees(gitCwd);
    } catch (error) {
      vscode.window.showErrorMessage(`git worktree prune failed — ${stderrOf(error)}`);
      return;
    }
    await forgetWorktree({ context, id: worktree.id });
    vscode.window.showInformationMessage(`Cleared the registration for "${name}".`);
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete worktree "${name}"?`,
    {
      modal: true,
      detail: `Removes ${worktree.path}\n\nThe branch "${worktree.branch}" is kept.`,
    },
    "Delete",
  );
  if (confirmed !== "Delete") return;

  try {
    await removeWorktreeAt({ path: worktree.path, gitCwd, force: false });
  } catch (error) {
    /* WHY: git refuses when the worktree holds modified OR untracked files. Forcing past that
       destroys work, so show exactly what would be lost before offering it. */
    const stderr = stderrOf(error);
    if (!stderr.includes("modified or untracked")) {
      vscode.window.showErrorMessage(`git worktree remove failed — ${stderr}`);
      return;
    }
    const dirt = await describeDirt(worktree.path).catch(() => "(could not list changes)");
    const forced = await vscode.window.showWarningMessage(
      `"${name}" has uncommitted changes. Delete anyway and lose them?`,
      { modal: true, detail: dirt },
      "Delete anyway",
    );
    if (forced !== "Delete anyway") return;
    try {
      await removeWorktreeAt({ path: worktree.path, gitCwd, force: true });
    } catch (forceError) {
      vscode.window.showErrorMessage(`git worktree remove failed — ${stderrOf(forceError)}`);
      return;
    }
  }

  await forgetWorktree({ context, id: worktree.id });

  if (!isCurrent) {
    vscode.window.showInformationMessage(`Deleted worktree "${name}".`);
    return;
  }

  /* WHY: the folder this window has open no longer exists — move to the primary worktree.
     openFolder tears down the extension host, so nothing may follow it. */
  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(mainPath), {
    forceReuseWindow: true,
  });
};
