import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const SWITCH_COMMAND = "worktreeManager.switch";
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

const parseWorktree = (record: string) => {
  const fields = record.split("\0").filter(Boolean);
  const worktreePath = fields
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!worktreePath) return undefined;

  const branchRef = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
  const id = resolveWorktreeId(worktreePath);

  return {
    id,
    path: worktreePath,
    branch: branchRef?.replace("refs/heads/", "") ?? "detached",
    isMain: id === MAIN_WORKTREE_ID,
  };
};

const listWorktrees = async (cwd: string) => {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], { cwd });
  return stdout
    .split("\0\0")
    .map(parseWorktree)
    .filter((worktree) => worktree !== undefined);
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
  const worktrees = await listWorktrees(cwd);
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

  picker.onDidTriggerItemButton(async ({ item }) => {
    if (!isWorktreeItem(item)) return;
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
  );

  if (!root) return;

  const worktrees = await listWorktrees(root).catch(() => []);
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
