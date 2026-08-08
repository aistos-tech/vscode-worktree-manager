import { basename } from "node:path";
import * as vscode from "vscode";
import { bootstrapWorktree } from "./bootstrap";
import { resolveHook } from "./config";
import { createWorktree } from "./create";
import {
  badgeFor,
  bindIssue,
  identifierFor,
  openIssue,
  publishLinearEnabled,
  tooltipLinkFor,
} from "./linear/badge";
import { deleteWorktree, renameWorktree } from "./manage";
import {
  ensureColours,
  type OpenedMap,
  PALETTE,
  readOpened,
  readPinned,
  rememberOpened,
  togglePinned,
} from "./state";
import { forgetApproval, listApprovals } from "./trust";
import { isNotARepo, listWorktrees, stderrOf, type Worktree } from "./worktree";

const SWITCH_COMMAND = "worktreeManager.switch";
const RENAME_COMMAND = "worktreeManager.rename";
const DELETE_COMMAND = "worktreeManager.delete";
const CREATE_COMMAND = "worktreeManager.create";
const OPEN_ISSUE_COMMAND = "worktreeManager.linear.openIssue";
const BIND_ISSUE_COMMAND = "worktreeManager.linear.bindIssue";
const FORGET_APPROVAL_COMMAND = "worktreeManager.hooks.forget";
const LIST_APPROVALS_COMMAND = "worktreeManager.hooks.listApprovals";
const BOOTSTRAP_COMMAND = "worktreeManager.bootstrap";
const RENAME_TOOLTIP = "Rename";
const DELETE_TOOLTIP = "Delete";
const BOOTSTRAP_TOOLTIP = "Re-run the post-create hook";
const PIN_TOOLTIP = "Pin";
const UNPIN_TOOLTIP = "Unpin";

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
  identifier: string | undefined;
};

const renderStatus = ({ item, worktree, colour, identifier }: RenderStatusProps) => {
  const name = basename(worktree.path);
  item.text = `$(git-branch) ${name}${badgeFor(identifier)}`;
  item.color = colour;
  const tooltip = new vscode.MarkdownString(
    `**${name}** · \`${worktree.branch}\`\n\n${worktree.path}\n\nColour \`${colour}\`${tooltipLinkFor(identifier)}`,
  );
  /* The tooltip carries a link now, so it has to be trusted for the link to be clickable. */
  tooltip.isTrusted = true;
  item.tooltip = tooltip;
  item.command = SWITCH_COMMAND;
  item.show();
};

type WorktreeItem = vscode.QuickPickItem & { worktree: Worktree };

type ToItemProps = {
  worktree: Worktree;
  isPinned: boolean;
  isCurrent: boolean;
  canBootstrap: boolean;
};

const toItem = ({ worktree, isPinned, isCurrent, canBootstrap }: ToItemProps): WorktreeItem => ({
  label: `${isCurrent ? "$(check)" : "$(circle-outline)"} ${basename(worktree.path)}`,
  description: worktree.branch,
  buttons: [
    ...(worktree.isMain
      ? []
      : [
          /* Never on the primary's row — one click there would re-bootstrap the primary itself —
             and never in a repo with no postCreate hook, where it would be a dead button. */
          ...(canBootstrap
            ? [{ iconPath: new vscode.ThemeIcon("sync"), tooltip: BOOTSTRAP_TOOLTIP }]
            : []),
          { iconPath: new vscode.ThemeIcon("edit"), tooltip: RENAME_TOOLTIP },
          { iconPath: new vscode.ThemeIcon("trash"), tooltip: DELETE_TOOLTIP },
        ]),
    {
      iconPath: new vscode.ThemeIcon(isPinned ? "pinned" : "pin"),
      tooltip: isPinned ? UNPIN_TOOLTIP : PIN_TOOLTIP,
    },
  ],
  worktree,
});

/* WHY: most recently opened first, then newest created — the worktrees you are moving between rise
   to the top, and one that has never been opened still lands near them while it is fresh, rather
   than in whatever order git happened to list it. */
const byRecency = (opened: OpenedMap) => (left: Worktree, right: Worktree) =>
  (opened[right.id] ?? 0) - (opened[left.id] ?? 0) || right.createdAt - left.createdAt;

type BuildItemsProps = {
  worktrees: Worktree[];
  pinned: string[];
  opened: OpenedMap;
  currentPath: string | undefined;
  canBootstrap: boolean;
};

const buildItems = ({ worktrees, pinned, opened, currentPath, canBootstrap }: BuildItemsProps) => {
  const toEntry = (worktree: Worktree) =>
    toItem({
      worktree,
      isPinned: pinned.includes(worktree.id),
      isCurrent: worktree.path === currentPath,
      canBootstrap,
    });

  const ordered = [...worktrees].sort(byRecency(opened));
  const pinnedEntries = ordered.filter((worktree) => pinned.includes(worktree.id)).map(toEntry);
  const restEntries = ordered.filter((worktree) => !pinned.includes(worktree.id)).map(toEntry);

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

type CreateItem = vscode.QuickPickItem & { create: true };

const isCreateItem = (item: vscode.QuickPickItem): item is CreateItem => "create" in item;

/* The label embeds the typed text verbatim, which is what keeps the row visible while filtering:
   fuzzy matching needs the query's characters in order, and they are literally present. A static
   "New worktree…" row is hidden by the filter at exactly the moment it is wanted — you type a
   branch name that matches no existing worktree, and the one row that could act on it disappears. */
const createItem = (query: string): CreateItem => ({
  label: query ? `$(add) Create worktree "${query}"` : "$(add) New worktree…",
  alwaysShow: true,
  create: true,
});

type ShowSwitcherProps = {
  context: vscode.ExtensionContext;
  cwd: string;
  currentPath: string | undefined;
};

const showSwitcher = async ({ context, cwd, currentPath }: ShowSwitcherProps) => {
  const worktrees = await loadWorktrees({ cwd, announce: true });
  if (worktrees.length === 0) return;
  await ensureColours({ context, worktrees });

  const mainPath = worktrees.find((worktree) => worktree.isMain)?.path ?? cwd;
  const canBootstrap = Boolean(resolveHook({ hook: "postCreate", primaryPath: mainPath }).command);

  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.placeholder = "Switch worktree";
  picker.matchOnDescription = true;

  const refresh = () => {
    /* Reassigning items resets activeItems to the first row, so capture and restore it — otherwise
       the highlight jumps home on every keystroke, which is the defect the create row introduces
       by needing to be rebuilt as the query changes. Restored by INSTANCE: matching is by object
       identity, so a fresh object with an identical label does not restore the highlight. */
    const active = picker.activeItems;
    picker.items = [
      ...buildItems({
        worktrees,
        pinned: readPinned(context),
        opened: readOpened(context),
        currentPath,
        canBootstrap,
      }),
      createItem(picker.value.trim()),
    ];
    const restored = picker.items.filter((item) => active.includes(item));
    if (restored.length) picker.activeItems = restored;
  };
  refresh();

  picker.onDidChangeValue(() => refresh());

  /* Dispatches on tooltip, and EVERY case is explicit. The pin toggle used to be the unguarded
     else, so any button added without its own branch fell through and silently pinned or unpinned
     the row instead of doing its own job — a `$(sync)` that pins is a confusing bug, and the next
     button into the same trap would be worse. */
  picker.onDidTriggerItemButton(async ({ item, button }) => {
    if (!isWorktreeItem(item)) return;

    if (button.tooltip === BOOTSTRAP_TOOLTIP) {
      picker.dispose();
      await bootstrapWorktree({
        context,
        worktree: item.worktree,
        primaryPath: mainPath,
      });
      return;
    }

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

    if (button.tooltip === PIN_TOOLTIP || button.tooltip === UNPIN_TOOLTIP) {
      await togglePinned(context, item.worktree.id);
      refresh();
    }
  });

  /* WHY: openFolder with forceReuseWindow tears down the extension host mid-call —
     nothing after it runs, so dispose before handing over. */
  picker.onDidAccept(() => {
    const [selected] = picker.selectedItems;
    if (!selected) return;
    if (isCreateItem(selected)) {
      const seed = picker.value.trim();
      picker.dispose();
      void createWorktree({
        context,
        gitCwd: mainPath,
        worktrees,
        branchSeed: seed || undefined,
      });
      return;
    }
    if (!isWorktreeItem(selected)) return;
    picker.dispose();
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.worktree.path), {
      forceReuseWindow: true,
    });
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
};

type CurrentWorktreeProps = {
  root: string;
  announce: boolean;
};

const withCurrentWorktree = async ({ root, announce }: CurrentWorktreeProps) => {
  const worktrees = await loadWorktrees({ cwd: root, announce });
  const current = worktrees.find((worktree) => worktree.path === root);
  if (!current) return undefined;
  return {
    worktrees,
    current,
    mainPath: worktrees.find((worktree) => worktree.isMain)?.path ?? root,
  };
};

export const activate = async (context: vscode.ExtensionContext) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const requireRoot = () => {
    if (root) return root;
    vscode.window.showWarningMessage("Worktree Manager: no folder open.");
    return undefined;
  };

  const requireCurrent = async () => {
    const cwd = requireRoot();
    if (!cwd) return undefined;
    const resolved = await withCurrentWorktree({ root: cwd, announce: true });
    if (!resolved) {
      vscode.window.showWarningMessage("Worktree Manager: this folder is not a git worktree.");
      return undefined;
    }
    return resolved;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(SWITCH_COMMAND, () => {
      const cwd = requireRoot();
      if (!cwd) return;
      return showSwitcher({ context, cwd, currentPath: cwd });
    }),
    vscode.commands.registerCommand(RENAME_COMMAND, async () => {
      const resolved = await requireCurrent();
      if (!resolved) return;
      return renameWorktree({
        worktree: resolved.current,
        isCurrent: true,
        gitCwd: resolved.mainPath,
      });
    }),
    /* Revocation needs enumeration beside it: a trust store the user cannot list is one they
       cannot audit after a prompt they did not expect. A QuickPick over the stored keys gives both
       from one command. */
    vscode.commands.registerCommand(CREATE_COMMAND, async () => {
      const cwd = requireRoot();
      if (!cwd) return;
      const worktrees = await loadWorktrees({ cwd, announce: true });
      return createWorktree({
        context,
        gitCwd: worktrees.find((worktree) => worktree.isMain)?.path ?? cwd,
        worktrees,
      });
    }),
    vscode.commands.registerCommand(BOOTSTRAP_COMMAND, async () => {
      const resolved = await requireCurrent();
      if (!resolved) return;
      return bootstrapWorktree({
        context,
        worktree: resolved.current,
        primaryPath: resolved.mainPath,
      });
    }),
    vscode.commands.registerCommand(FORGET_APPROVAL_COMMAND, async () => {
      const approvals = listApprovals(context);
      if (approvals.length === 0) {
        vscode.window.showInformationMessage("Worktree Manager: no hook approvals are stored.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        approvals.map((entry) => ({
          label: `$(trash) ${entry.path}`,
          description: entry.approval?.command,
          detail: entry.approval?.origin,
          path: entry.path,
        })),
        { title: "Forget which hook approval?", placeHolder: "The hook is re-approved next run" },
      );
      if (!picked) return;
      await forgetApproval(context, picked.path);
      vscode.window.showInformationMessage(`Forgot the hook approval for ${picked.path}.`);
    }),
    vscode.commands.registerCommand(LIST_APPROVALS_COMMAND, () => {
      const approvals = listApprovals(context);
      if (approvals.length === 0) {
        vscode.window.showInformationMessage("Worktree Manager: no hook approvals are stored.");
        return;
      }
      const lines = approvals.map((entry) => `${entry.path}\n  ${entry.approval?.command ?? "?"}`);
      vscode.window.showInformationMessage(`${approvals.length} approved repo(s)`, {
        modal: true,
        detail: lines.join("\n\n"),
      });
    }),
    vscode.commands.registerCommand(DELETE_COMMAND, async () => {
      const resolved = await requireCurrent();
      if (!resolved) return;
      return deleteWorktree({
        context,
        worktree: resolved.current,
        isCurrent: true,
        gitCwd: resolved.mainPath,
        mainPath: resolved.mainPath,
      });
    }),
  );

  if (!root) return;

  const resolved = await withCurrentWorktree({ root, announce: false });
  if (!resolved) return;

  await publishLinearEnabled();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("worktreeManager.linear.workspace")) {
        void publishLinearEnabled();
      }
    }),
  );

  await rememberOpened({ context, id: resolved.current.id });
  const colours = await ensureColours({ context, worktrees: resolved.worktrees });
  const item = vscode.window.createStatusBarItem(
    "worktreeManager.current",
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = "Worktree";
  const render = () =>
    renderStatus({
      item,
      worktree: resolved.current,
      colour: colours[resolved.current.id] ?? PALETTE[0],
      identifier: identifierFor({
        context,
        worktreeId: resolved.current.id,
        branch: resolved.current.branch,
      }),
    });
  render();
  context.subscriptions.push(item);

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_ISSUE_COMMAND, () => {
      const identifier = identifierFor({
        context,
        worktreeId: resolved.current.id,
        branch: resolved.current.branch,
      });
      if (!identifier) {
        vscode.window.showInformationMessage(
          'Worktree Manager: no Linear issue on this branch. Bind one with "Worktree: Bind Linear Issue…".',
        );
        return;
      }
      return openIssue(identifier);
    }),
    vscode.commands.registerCommand(BIND_ISSUE_COMMAND, async () => {
      await bindIssue({ context, worktreeId: resolved.current.id });
      render();
    }),
  );
};

export const deactivate = () => {};
