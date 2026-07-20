import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const SWITCH_COMMAND = "worktreeManager.switch";
const RENAME_COMMAND = "worktreeManager.rename";
const DELETE_COMMAND = "worktreeManager.delete";
const RENAME_TOOLTIP = "Rename";
const DELETE_TOOLTIP = "Delete";
const PINNED_KEY = "pinnedWorktreeIds";
const COLOUR_KEY = "worktreeColours";
const MAIN_WORKTREE_ID = "__main__";

const PALETTE = [
  "#FF6B6B",
  "#FF8E4F",
  "#FFB03A",
  "#FFD43B",
  "#D8E64B",
  "#94D82D",
  "#51CF66",
  "#38D9A9",
  "#22CCCC",
  "#3BB2E8",
  "#4D94F7",
  "#7C7CF7",
  "#A97CF7",
  "#CE72EC",
  "#EC72C6",
  "#F76B93",
] as const;

type Worktree = {
  id: string;
  path: string;
  branch: string;
  isMain: boolean;
};

type ColourMap = Record<string, string>;

/* WHY: the git admin dir name is assigned at creation and survives `git worktree move`,
   so it is the only worktree identifier stable across a rename. */
const resolveWorktreeId = (worktreePath: string) => {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath) || statSync(gitPath).isDirectory()) return MAIN_WORKTREE_ID;
  const gitdir = readFileSync(gitPath, "utf8")
    .trim()
    .replace(/^gitdir:\s*/, "");
  return basename(gitdir);
};

const hashToIndex = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 0x7fffffff;
  }
  return hash % PALETTE.length;
};

/* WHY: hashing alone collided on 7 of 14 real worktrees — 14 names into 16 buckets makes
   the birthday problem near-certain. Hash only picks the preferred slot; probing forward
   to a free one is what guarantees distinctness. */
type PickColourProps = {
  name: string;
  used: Set<string>;
};

const pickColour = ({ name, used }: PickColourProps) => {
  const start = hashToIndex(name);
  for (let offset = 0; offset < PALETTE.length; offset += 1) {
    const candidate = PALETTE[(start + offset) % PALETTE.length];
    if (candidate && !used.has(candidate)) return candidate;
  }
  return PALETTE[start] ?? PALETTE[0];
};

type EnsureColoursProps = {
  context: vscode.ExtensionContext;
  worktrees: Worktree[];
};

/* WHY: colour is assigned once and persisted under the rename-stable id, never re-derived.
   Deriving it per-render would make every worktree's colour depend on the current set, so
   adding one worktree would reshuffle the others. */
const ensureColours = async ({ context, worktrees }: EnsureColoursProps) => {
  const assigned: ColourMap = {
    ...context.globalState.get<ColourMap>(COLOUR_KEY, {}),
  };
  const missing = worktrees.filter((worktree) => !assigned[worktree.id]);
  if (missing.length === 0) return assigned;

  for (const worktree of missing) {
    assigned[worktree.id] = pickColour({
      name: basename(worktree.path),
      used: new Set(Object.values(assigned)),
    });
  }
  await context.globalState.update(COLOUR_KEY, assigned);
  return assigned;
};

const stderrOf = (error: unknown) => {
  if (error instanceof Error && "stderr" in error) return String(error.stderr).trim();
  return error instanceof Error ? error.message : String(error);
};

const parseWorktree = (fields: string[]) => {
  const present = fields.filter(Boolean);
  const worktreePath = present
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!worktreePath) return undefined;

  const branchRef = present.find((field) => field.startsWith("branch "))?.slice("branch ".length);
  const id = resolveWorktreeId(worktreePath);

  return {
    id,
    path: worktreePath,
    branch: branchRef?.replace("refs/heads/", "") ?? "detached",
    isMain: id === MAIN_WORKTREE_ID,
  };
};

/* WHY: `worktree list -z` needs git ≥ 2.36 and hard-errors (exit 129) on older git — Ubuntu
   22.04 ships 2.34, so a Remote-SSH host is a realistic case. Fall back to the newline format,
   but only for that specific rejection: any other git failure must still propagate. */
const readWorktreeRecords = async (cwd: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
    });
    return stdout.split("\0\0").map((record) => record.split("\0"));
  } catch (error) {
    if (!/unknown (switch|option)/i.test(stderrOf(error))) throw error;
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
    return stdout.split("\n\n").map((record) => record.split("\n"));
  }
};

const listWorktrees = async (cwd: string) => {
  const records = await readWorktreeRecords(cwd);
  return records.map(parseWorktree).filter((worktree) => worktree !== undefined);
};

const isNotARepo = (error: unknown) => /not a git repository/i.test(stderrOf(error));

/* WHY: a swallowed git failure looks identical to "no worktrees" — the extension just fails to
   appear, with nothing to diagnose. Only a non-repo folder is legitimately silent, and only when
   the user did not ask for anything. */
type LoadWorktreesProps = {
  cwd: string;
  announce: boolean;
};

const loadWorktrees = async ({ cwd, announce }: LoadWorktreesProps) => {
  try {
    return await listWorktrees(cwd);
  } catch (error) {
    if (announce || !isNotARepo(error)) {
      vscode.window.showErrorMessage(`Worktree Manager: ${stderrOf(error)}`);
    }
    return [];
  }
};

type RenderStatusProps = {
  item: vscode.StatusBarItem;
  worktree: Worktree;
  colour: string;
};

const renderStatus = ({ item, worktree, colour }: RenderStatusProps) => {
  const name = basename(worktree.path);
  item.text = `$(git-branch) ${name}`;
  item.color = colour;
  item.tooltip = new vscode.MarkdownString(
    `**${name}** · \`${worktree.branch}\`\n\n${worktree.path}\n\nColour \`${colour}\``,
  );
  item.command = SWITCH_COMMAND;
  item.show();
};

type ValidateNameProps = {
  value: string;
  currentName: string;
  parent: string;
};

const validateName = ({ value, currentName, parent }: ValidateNameProps) => {
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
const renameWorktree = async ({ worktree, isCurrent, gitCwd }: RenameWorktreeProps) => {
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
    await execFileAsync("git", ["worktree", "move", worktree.path, target], {
      cwd: gitCwd,
    });
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

type RemoveAtProps = {
  path: string;
  gitCwd: string;
  force: boolean;
};

const removeWorktreeAt = ({ path, gitCwd, force }: RemoveAtProps) =>
  execFileAsync("git", ["worktree", "remove", ...(force ? ["--force"] : []), path], {
    cwd: gitCwd,
  });

const describeDirt = async (worktreePath: string) => {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
  });
  const lines = stdout.split("\n").filter(Boolean);
  const shown = lines.slice(0, 10).join("\n");
  return lines.length > 10 ? `${shown}\n… and ${lines.length - 10} more` : shown;
};

/* WHY: the colour map is keyed by worktree id and bounded by the palette, so an entry left
   behind after a delete permanently occupies one of 16 slots. */
type ForgetProps = {
  context: vscode.ExtensionContext;
  id: string;
};

const forgetWorktree = async ({ context, id }: ForgetProps) => {
  const colours = { ...context.globalState.get<ColourMap>(COLOUR_KEY, {}) };
  delete colours[id];
  await context.globalState.update(COLOUR_KEY, colours);

  const pinned = context.globalState.get<string[]>(PINNED_KEY, []);
  if (!pinned.includes(id)) return;
  await context.globalState.update(
    PINNED_KEY,
    pinned.filter((pinnedId) => pinnedId !== id),
  );
};

type DeleteWorktreeProps = {
  context: vscode.ExtensionContext;
  worktree: Worktree;
  isCurrent: boolean;
  gitCwd: string;
  mainPath: string;
};

const deleteWorktree = async ({
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

type WorktreeItem = vscode.QuickPickItem & { worktree: Worktree };

type ToItemProps = {
  worktree: Worktree;
  isPinned: boolean;
  isCurrent: boolean;
};

const toItem = ({ worktree, isPinned, isCurrent }: ToItemProps): WorktreeItem => ({
  label: `${isCurrent ? "$(check)" : "$(circle-outline)"} ${basename(worktree.path)}`,
  description: worktree.branch,
  buttons: [
    ...(worktree.isMain
      ? []
      : [
          { iconPath: new vscode.ThemeIcon("edit"), tooltip: RENAME_TOOLTIP },
          { iconPath: new vscode.ThemeIcon("trash"), tooltip: DELETE_TOOLTIP },
        ]),
    {
      iconPath: new vscode.ThemeIcon(isPinned ? "pinned" : "pin"),
      tooltip: isPinned ? "Unpin" : "Pin",
    },
  ],
  worktree,
});

type BuildItemsProps = {
  worktrees: Worktree[];
  pinned: string[];
  currentPath: string | undefined;
};

const buildItems = ({ worktrees, pinned, currentPath }: BuildItemsProps) => {
  const toEntry = (worktree: Worktree) =>
    toItem({
      worktree,
      isPinned: pinned.includes(worktree.id),
      isCurrent: worktree.path === currentPath,
    });

  const pinnedEntries = worktrees.filter((worktree) => pinned.includes(worktree.id)).map(toEntry);
  const restEntries = worktrees.filter((worktree) => !pinned.includes(worktree.id)).map(toEntry);

  const separator = (label: string) => ({
    label,
    kind: vscode.QuickPickItemKind.Separator,
  });

  return [
    ...(pinnedEntries.length > 0 ? [separator("Pinned"), ...pinnedEntries] : []),
    ...(restEntries.length > 0 ? [separator("Worktrees"), ...restEntries] : []),
  ];
};

const isWorktreeItem = (item: vscode.QuickPickItem): item is WorktreeItem => "worktree" in item;

type ShowSwitcherProps = {
  context: vscode.ExtensionContext;
  cwd: string;
  currentPath: string | undefined;
};

const showSwitcher = async ({ context, cwd, currentPath }: ShowSwitcherProps) => {
  const worktrees = await loadWorktrees({ cwd, announce: true });
  if (worktrees.length === 0) return;
  await ensureColours({ context, worktrees });

  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.placeholder = "Switch worktree";
  picker.matchOnDescription = true;

  const refresh = () => {
    picker.items = buildItems({
      worktrees,
      pinned: context.globalState.get<string[]>(PINNED_KEY, []),
      currentPath,
    });
  };
  refresh();

  picker.onDidTriggerItemButton(async ({ item, button }) => {
    if (!isWorktreeItem(item)) return;

    const mainPath = worktrees.find((worktree) => worktree.isMain)?.path ?? cwd;

    if (button.tooltip === RENAME_TOOLTIP) {
      picker.dispose();
      await renameWorktree({
        worktree: item.worktree,
        isCurrent: item.worktree.path === currentPath,
        gitCwd: mainPath,
      });
      return;
    }

    if (button.tooltip === DELETE_TOOLTIP) {
      picker.dispose();
      await deleteWorktree({
        context,
        worktree: item.worktree,
        isCurrent: item.worktree.path === currentPath,
        gitCwd: mainPath,
        mainPath,
      });
      return;
    }

    const pinned = context.globalState.get<string[]>(PINNED_KEY, []);
    const next = pinned.includes(item.worktree.id)
      ? pinned.filter((id) => id !== item.worktree.id)
      : [...pinned, item.worktree.id];
    await context.globalState.update(PINNED_KEY, next);
    refresh();
  });

  /* WHY: openFolder with forceReuseWindow tears down the extension host mid-call —
     nothing after it runs, so dispose before handing over. */
  picker.onDidAccept(() => {
    const [selected] = picker.selectedItems;
    if (!selected || !isWorktreeItem(selected)) return;
    picker.dispose();
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.worktree.path), {
      forceReuseWindow: true,
    });
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
};

export const activate = async (context: vscode.ExtensionContext) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.commands.registerCommand(SWITCH_COMMAND, () => {
      if (!root) {
        vscode.window.showWarningMessage("Worktree Manager: no folder open.");
        return;
      }
      return showSwitcher({ context, cwd: root, currentPath: root });
    }),
    vscode.commands.registerCommand(RENAME_COMMAND, async () => {
      if (!root) {
        vscode.window.showWarningMessage("Worktree Manager: no folder open.");
        return;
      }
      const worktrees = await loadWorktrees({ cwd: root, announce: true });
      const current = worktrees.find((worktree) => worktree.path === root);
      if (!current) {
        vscode.window.showWarningMessage("Worktree Manager: this folder is not a git worktree.");
        return;
      }
      return renameWorktree({
        worktree: current,
        isCurrent: true,
        gitCwd: worktrees.find((worktree) => worktree.isMain)?.path ?? root,
      });
    }),
    vscode.commands.registerCommand(DELETE_COMMAND, async () => {
      if (!root) {
        vscode.window.showWarningMessage("Worktree Manager: no folder open.");
        return;
      }
      const worktrees = await loadWorktrees({ cwd: root, announce: true });
      const current = worktrees.find((worktree) => worktree.path === root);
      if (!current) {
        vscode.window.showWarningMessage("Worktree Manager: this folder is not a git worktree.");
        return;
      }
      const mainPath = worktrees.find((worktree) => worktree.isMain)?.path ?? root;
      return deleteWorktree({
        context,
        worktree: current,
        isCurrent: true,
        gitCwd: mainPath,
        mainPath,
      });
    }),
  );

  if (!root) return;

  const worktrees = await loadWorktrees({ cwd: root, announce: false });
  const current = worktrees.find((worktree) => worktree.path === root);
  if (!current) return;

  const colours = await ensureColours({ context, worktrees });
  const item = vscode.window.createStatusBarItem(
    "worktreeManager.current",
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = "Worktree";
  renderStatus({
    item,
    worktree: current,
    colour: colours[current.id] ?? PALETTE[0],
  });
  context.subscriptions.push(item);
};

export const deactivate = () => {};
