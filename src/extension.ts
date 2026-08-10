import { basename } from "node:path";
import * as vscode from "vscode";
import { bootstrapWorktree } from "./bootstrap";
import { resolveHook } from "./config";
import { createWorktree } from "./create";
import { fetchPullRequests, GitHubError, hasGitHubSession, signInToGitHub } from "./github/client";
import { parseRemote } from "./github/remote";
import { linearToken, onSignOut, signIn, signOut } from "./linear/auth";
import {
  badgeFor,
  bindIssue,
  identifierFor,
  linearWorkspace,
  openIssue,
  publishLinearEnabled,
  tooltipLinkFor,
} from "./linear/badge";
import { fetchMyIssues, LinearError } from "./linear/client";
import { issueIdFor } from "./linear/id";
import { closePreview, showIssuePreview } from "./linear/preview";
import { createIssueView, ISSUE_VIEW_ID } from "./linear/view";
import { deleteWorktree, renameWorktree } from "./manage";
import {
  type CachedRow,
  clearCache,
  describeAge,
  readCache,
  readPrCache,
  writeCache,
  writePrCache,
} from "./picker/cache";
import { enterPicker, exitAll, exitPicker } from "./picker/context-keys";
import { errorNote, type Note, type NoteAction, noteRow, signInNote } from "./picker/notes";
import {
  byGroupThenLocal,
  byLocalFirst,
  groupStarts,
  localSplitIndex,
  PR_GROUP_LABEL,
  type PrGroup,
} from "./picker/order";
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
import { isNotARepo, listWorktrees, originUrl, stderrOf, type Worktree } from "./worktree";

const SWITCH_COMMAND = "worktreeManager.switch";
const RENAME_COMMAND = "worktreeManager.rename";
const DELETE_COMMAND = "worktreeManager.delete";
const CREATE_COMMAND = "worktreeManager.create";
const SHOW_WORKTREES_COMMAND = "worktreeManager.showWorktrees";
const SHOW_LINEAR_COMMAND = "worktreeManager.showLinear";
const SHOW_PRS_COMMAND = "worktreeManager.showPRs";
const SIGN_IN_COMMAND = "worktreeManager.linear.signIn";
const SIGN_OUT_COMMAND = "worktreeManager.linear.signOut";
const PREVIEW_ISSUE_COMMAND = "worktreeManager.linear.previewIssue";
const PREVIEW_BACK_COMMAND = "worktreeManager.linear.previewBack";
const REFRESH_ISSUE_COMMAND = "worktreeManager.linear.refreshIssue";
const SHOW_ISSUE_COMMAND = "worktreeManager.linear.showIssue";
const NEXT_CONTEXT_COMMAND = "worktreeManager.nextContext";
const PREVIOUS_CONTEXT_COMMAND = "worktreeManager.previousContext";
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
      vscode.window.showErrorMessage(`Aistos: ${stderrOf(error)}`);
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
  /* NOT trusted. An `isTrusted` MarkdownString executes `command:` URIs, and this interpolates a
     branch name — free text that git barely constrains — so a branch named
     `x](command:some.command)` would render an executable link in the status bar. Ordinary https
     links are clickable without it, so trusting buys nothing and costs that. */
  item.tooltip = new vscode.MarkdownString(
    `**${name}** · \`${worktree.branch}\`\n\n${worktree.path}\n\nColour \`${colour}\`${tooltipLinkFor(identifier)}`,
  );
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

type PrItem = vscode.QuickPickItem & { prBranch: string; prUrl: string };

const isPrItem = (item: vscode.QuickPickItem): item is PrItem => "prBranch" in item;

type IssueItem = vscode.QuickPickItem & { issueBranch: string };

const isIssueItem = (item: vscode.QuickPickItem): item is IssueItem => "issueBranch" in item;

/* Existence is a per-row badge inside a single-source list, which is exactly what contexts buy:
   `✓` means a worktree already exists for this branch and selecting it switches, `○` means it does
   not and selecting it creates one. */
const issueItem = (row: CachedRow & { local: boolean }): IssueItem => ({
  label: `${row.local ? "$(check)" : "$(circle-outline)"} ${row.identifier} ${row.title}`,
  description: row.state,
  /* A local row keeps a detail line rather than dropping to nothing — otherwise the rows you can
     act on most cheaply are the sparsest ones on screen. */
  detail: row.local ? `${row.branch} · worktree open` : `Creates a worktree on ${row.branch}`,
  issueBranch: row.branch,
});

/* Splits the two groups with a separator, so "the ones you already have" reads as a grouping rather
   than as an accident of ordering. Nothing is inserted when either group is empty. */
const withLocalSeparator = <T extends { local: boolean }>(
  ordered: readonly T[],
  toItem: (row: T) => vscode.QuickPickItem,
): vscode.QuickPickItem[] => {
  const split = localSplitIndex(ordered);
  return ordered.flatMap((row, index) =>
    index === split
      ? [
          {
            label: "Not checked out",
            kind: vscode.QuickPickItemKind.Separator,
          },
          toItem(row),
        ]
      : [toItem(row)],
  );
};

export type PrRow = {
  number: number;
  title: string;
  branch: string;
  url: string;
  group: PrGroup;
  isDraft: boolean;
  reviewDecision: string | undefined;
};

/* One separator ahead of each group. `groupStarts` marks index 0 too, so the first group is
   labelled as well — with three groups in play, an unlabelled top block reads as ungrouped. */
const withGroupSeparators = <T extends { group: PrGroup }>(
  ordered: readonly T[],
  toItem: (row: T) => vscode.QuickPickItem,
): vscode.QuickPickItem[] => {
  const starts = groupStarts(ordered);
  return ordered.flatMap((row, index) => {
    const group = starts.get(index);
    return group
      ? [{ label: PR_GROUP_LABEL[group], kind: vscode.QuickPickItemKind.Separator }, toItem(row)]
      : [toItem(row)];
  });
};

/* Draft and review state on the row itself, so a queue can be triaged without opening anything. */
const describePr = (row: {
  isDraft: boolean;
  reviewDecision: string | undefined;
  local: boolean;
}) =>
  [
    row.isDraft ? "draft" : undefined,
    row.reviewDecision === "APPROVED"
      ? "approved"
      : row.reviewDecision === "CHANGES_REQUESTED"
        ? "changes requested"
        : row.reviewDecision === "REVIEW_REQUIRED"
          ? "review required"
          : undefined,
    row.local ? "worktree open" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

type NoteItem = vscode.QuickPickItem & { noteAction: NoteAction };

/* The label embeds the typed text verbatim, which is what keeps the row visible while filtering:
   fuzzy matching needs the query's characters in order, and they are literally present. A static
   "New worktree…" row is hidden by the filter at exactly the moment it is wanted. */
const createItem = (query: string): CreateItem => ({
  label: query ? `$(add) Create worktree "${query}"` : "$(add) New worktree…",
  alwaysShow: true,
  create: true,
});

const isNoteItem = (item: vscode.QuickPickItem): item is NoteItem => "noteAction" in item;

type CreateItem = vscode.QuickPickItem & { create: true };

const isCreateItem = (item: vscode.QuickPickItem): item is CreateItem => "create" in item;

/* Three contexts over one picker. The mechanism was proven on the instant, offline,
   credential-free case before either network context was built on top of it. */
export type PickerContext = "worktrees" | "linear" | "prs";

const CONTEXTS: {
  id: PickerContext;
  icon: string;
  tooltip: string;
  placeholder: string;
}[] = [
  {
    id: "worktrees",
    icon: "git-branch",
    tooltip: "Worktrees",
    placeholder: "Switch worktree",
  },
  {
    id: "linear",
    icon: "issues",
    tooltip: "Linear issues",
    placeholder: "Linear issues assigned to you",
  },
  {
    id: "prs",
    icon: "git-pull-request",
    tooltip: "Pull requests",
    placeholder: "Pull requests awaiting your review",
  },
];

/* `toggle.checked` is real checked state VS Code maintains, so an active context does not have to
   be faked by swapping icons. Mutual exclusion is NOT provided — three toggles are three
   independent checkboxes — so the handler sets the clicked one and clears the other two, and
   `buttons` is reassigned to repaint because it is a readonly array. */
const stripFor = (active: PickerContext): vscode.QuickInputButton[] =>
  CONTEXTS.map((entry) => ({
    iconPath: new vscode.ThemeIcon(entry.icon),
    tooltip: entry.tooltip,
    location: vscode.QuickInputButtonLocation.Inline,
    toggle: { checked: entry.id === active },
  }));

type ShowSwitcherProps = {
  context: vscode.ExtensionContext;
  cwd: string;
  currentPath: string | undefined;
  initialContext?: PickerContext;
};

const showSwitcher = async ({
  context,
  cwd,
  currentPath,
  initialContext = "worktrees",
}: ShowSwitcherProps) => {
  const worktrees = await loadWorktrees({ cwd, announce: true });
  if (worktrees.length === 0) return;
  await ensureColours({ context, worktrees });

  const mainPath = worktrees.find((worktree) => worktree.isMain)?.path ?? cwd;
  const canBootstrap = Boolean(resolveHook({ hook: "postCreate", primaryPath: mainPath }).command);

  let active: PickerContext = initialContext;
  let issueRows: CachedRow[] = [];
  let issueNote: Note | undefined;
  let prRows: PrRow[] = [];
  let prNote: Note | undefined;
  /* Drops a response that lands after a newer one. VS Code does not debounce and a slow reply can
     arrive after the context has already changed, painting the wrong list. */
  let generation = 0;

  /* Set immediately before every programmatic hide()/show() hand-over. `show()` on the preview
     fires THIS picker's onDidHide first — verbatim in the typings, "Any other input UI will first
     fire an onDidHide event" — and the handler below is what would otherwise dispose the instance
     the preview needs to restore. There is no `onWillHide` to infer intent from after the fact. */
  let handingOverToPreview = false;

  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.matchOnDescription = true;
  /* Defaults to false, so without this every refresh scrolls the list home. */
  picker.keepScrollPosition = true;

  const refresh = () => {
    /* Reassigning items resets activeItems to the first row, so capture and restore it — otherwise
       the highlight jumps home on every keystroke, which is the defect the create row introduces
       by needing to be rebuilt as the query changes. Restored by INSTANCE: matching is by object
       identity, so a fresh object with an identical label does not restore the highlight. */
    const wasActive = picker.activeItems;
    picker.items = [
      /* Every context paints a row rather than an empty list when it has nothing: an empty
         QuickPick reads as a failed query. */
      ...(active === "linear"
        ? [
            ...(issueNote ? [noteRow(issueNote)] : []),
            ...withLocalSeparator(
              byLocalFirst(
                issueRows.map((row) => ({
                  ...row,
                  local: worktrees.some((worktree) => worktree.branch === row.branch),
                })),
              ),
              (row) => issueItem(row),
            ),
          ]
        : []),
      ...(active === "worktrees"
        ? [
            ...buildItems({
              worktrees,
              pinned: readPinned(context),
              opened: readOpened(context),
              currentPath,
              canBootstrap,
            }),
            createItem(picker.value.trim()),
          ]
        : []),
      ...(active === "prs"
        ? [
            ...(prNote ? [noteRow(prNote)] : []),
            ...withGroupSeparators(
              byGroupThenLocal(
                prRows.map((row) => ({
                  ...row,
                  local: worktrees.some((worktree) => worktree.branch === row.branch),
                })),
              ),
              (row) => ({
                label: `${row.local ? "$(check)" : "$(circle-outline)"} #${row.number} ${row.title}`,
                description: describePr(row),
                detail: row.branch,
                prBranch: row.branch,
                prUrl: row.url,
              }),
            ),
          ]
        : []),
    ];
    const restored = picker.items.filter((item) => wasActive.includes(item));
    if (restored.length) picker.activeItems = restored;
  };

  /* Paints the cached copy immediately and replaces it when fresh data lands — the picker never
     waits on the network before appearing. */
  const loadLinear = async () => {
    const key = `linear:${cwd}`;
    const cached = readCache({ context, key });
    if (cached) {
      issueRows = cached.rows;
      issueNote = { label: `$(history) as of ${describeAge(cached.at, Date.now())}` };
      refresh();
    }

    if (!(await linearToken(context))) {
      issueRows = [];
      issueNote = signInNote("linear");
      refresh();
      return;
    }

    const mine = ++generation;
    picker.busy = true;
    if (issueRows.length) issueNote = { label: "$(sync~spin) Refreshing…" };
    refresh();
    try {
      const issues = await fetchMyIssues(context);
      if (mine !== generation) return;
      const rows: CachedRow[] = issues.map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        state: issue.state.name,
        branch: issue.branchName,
      }));
      issueRows = rows;
      issueNote = rows.length ? undefined : { label: "$(inbox) No open issues assigned to you" };
      await writeCache({ context, key, rows });
      refresh();
    } catch (error) {
      if (mine !== generation) return;
      /* Never a blank list: an empty picker reads as "nothing assigned to you", which is a
         different claim from "the credential is wrong". */
      issueNote = errorNote({
        message: `${error instanceof LinearError ? error.message : String(error)}${
          issueRows.length ? " — showing cached" : ""
        }`,
        provider: "linear",
        recoverable: error instanceof LinearError,
      });
      refresh();
    } finally {
      if (mine === generation) picker.busy = false;
    }
  };

  const loadPrs = async () => {
    const prKey = `prs:${cwd}`;
    /* Cached first paint, same contract as the Linear context: the list appears immediately and is
       replaced when fresh data lands, rather than showing an empty picker for half a second. */
    const cachedPrs = readPrCache<PrRow>({ context, key: prKey });
    if (cachedPrs) {
      prRows = cachedPrs.rows;
      prNote = { label: `$(history) as of ${describeAge(cachedPrs.at, Date.now())}` };
      refresh();
    }

    const remote = parseRemote(await originUrl(cwd));
    if (!remote) {
      /* Not recoverable by signing in — offering it would send the user through an auth flow
         and leave them exactly where they were. */
      prNote = errorNote({
        message: "No GitHub remote on this repo",
        provider: "github",
        recoverable: false,
      });
      refresh();
      return;
    }
    if (!(await hasGitHubSession())) {
      prNote = signInNote("github");
      refresh();
      return;
    }
    const mine = ++generation;
    picker.busy = true;
    if (prRows.length) prNote = { label: "$(sync~spin) Refreshing…" };
    refresh();
    try {
      const prs = await fetchPullRequests(remote);
      if (mine !== generation) return;
      prRows = prs.map((pr) => ({
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        url: pr.url,
        group: pr.group,
        isDraft: pr.isDraft,
        reviewDecision: pr.reviewDecision,
      }));
      prNote = prRows.length ? undefined : { label: "$(inbox) No open pull requests" };
      await writePrCache({ context, key: prKey, rows: prRows });
      refresh();
    } catch (error) {
      if (mine !== generation) return;
      prNote = errorNote({
        message: error instanceof GitHubError ? error.message : String(error),
        provider: "github",
        recoverable: error instanceof GitHubError,
      });
      refresh();
    } finally {
      if (mine === generation) picker.busy = false;
    }
  };

  const applyContext = (next: PickerContext) => {
    active = next;
    const entry = CONTEXTS.find((candidate) => candidate.id === next);
    picker.placeholder = entry?.placeholder ?? "Switch worktree";
    picker.title = entry?.tooltip;
    picker.buttons = stripFor(next);
    refresh();
    if (next === "linear") void loadLinear();
    if (next === "prs") void loadPrs();
  };

  picker.onDidTriggerButton((button) => {
    const entry = CONTEXTS.find((candidate) => candidate.tooltip === button.tooltip);
    if (entry) applyContext(entry.id);
  });

  applyContext(active);

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
    /* The rows that offer an action. Handled BEFORE the item-type checks below, because a note is
       not a worktree, an issue or a PR and would otherwise fall through all of them — which is
       exactly the bug that made these rows inert. Signing in re-runs the load, so the list fills in
       without the user reopening the picker. */
    if (isNoteItem(selected)) {
      const action = selected.noteAction;
      if (action === "signInLinear") {
        void (async () => {
          const token = await signIn(context);
          if (token) await loadLinear();
        })();
        return;
      }
      if (action === "signInGitHub") {
        void (async () => {
          if (await signInToGitHub()) await loadPrs();
        })();
        return;
      }
      void (active === "linear" ? loadLinear() : loadPrs());
      return;
    }

    /* Read-only, deliberately. PR worktree CREATION is composed, not built: the GitHub PR
       extension already ships "Checkout Pull Request in Worktree", and re-implementing it here
       would duplicate a free, maintained feature. What nothing else provides is the join — knowing
       that #404 is the worktree you already have — so `✓` switches and `○` opens the PR. */
    if (isPrItem(selected)) {
      const branch = selected.prBranch;
      const match = worktrees.find((worktree) => worktree.branch === branch);
      const url = selected.prUrl;
      picker.dispose();
      if (match) {
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(match.path), {
          forceReuseWindow: true,
        });
        return;
      }
      if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    if (isIssueItem(selected)) {
      const branch = selected.issueBranch;
      const match = worktrees.find((worktree) => worktree.branch === branch);
      picker.dispose();
      if (match) {
        vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(match.path), {
          forceReuseWindow: true,
        });
        return;
      }
      /* Creates through the ordinary flow with the branch pre-filled — taken from Linear's own
         branchName VERBATIM, never rebuilt from a slug, because that string is what Linear matches
         branches and PRs against. */
      void createWorktree({ context, gitCwd: mainPath, worktrees, branchSeed: branch });
      return;
    }
    if (!isWorktreeItem(selected)) return;
    picker.dispose();
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(selected.worktree.path), {
      forceReuseWindow: true,
    });
  });

  /* Cleared BEFORE dispose and in a finally, so an exception between show() and here cannot leave
     the key set. See picker/context-keys.ts for why a stuck key is a workbench-wide problem.

     Conditional on the hand-over flag: disposing here during a hand-over would destroy the instance
     the preview is about to restore, and reading activeItems off it would throw. */
  picker.onDidHide(() => {
    if (handingOverToPreview) return;
    try {
      activePreviewTrigger = undefined;
      activeContextCycler = undefined;
      void exitAll();
    } finally {
      picker.dispose();
    }
  });

  /* Captured by INSTANCE before the hand-over and restored after, because QuickPick matches
     activeItems by object identity — a fresh object with an identical label does not restore the
     highlight. */
  const preview = async () => {
    const [row] = picker.activeItems;
    if (!row) return;
    /* Not the create row, and not a separator or a status line: → on those does nothing. */
    if (isCreateItem(row) || isNoteItem(row)) return;

    /* Every context resolves to the same shape, which is what makes → mean one thing everywhere:
       a unit of work that may have a branch, an issue and a PR. */
    const branch = isWorktreeItem(row)
      ? row.worktree.branch
      : isIssueItem(row)
        ? row.issueBranch
        : isPrItem(row)
          ? row.prBranch
          : undefined;
    if (branch === undefined) return;

    const worktree = worktrees.find((entry) => entry.branch === branch);
    const identifier = worktree
      ? identifierFor({ context, worktreeId: worktree.id, branch })
      : issueIdFor({ branch });

    const restore = picker.activeItems;
    handingOverToPreview = true;
    await exitPicker();
    await showIssuePreview({
      context,
      target: {
        identifier,
        branch,
        worktreePath: worktree?.path,
        worktreeName: worktree ? basename(worktree.path) : undefined,
        gitCwd: mainPath,
      },
      onBack: () => {
        handingOverToPreview = true;
        picker.show();
        picker.activeItems = restore;
        handingOverToPreview = false;
        void enterPicker();
      },
      onAction: (action) => {
        /* The picker is not reshown for an action: every one of these either replaces the window or
           opens something outside it, so returning to a list nobody is looking at is noise. */
        if (action.kind === "openWorktree") {
          picker.dispose();
          vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(action.path), {
            forceReuseWindow: true,
          });
          return;
        }
        if (action.kind === "createWorktree") {
          picker.dispose();
          void createWorktree({
            context,
            gitCwd: mainPath,
            worktrees,
            branchSeed: action.branch,
          });
          return;
        }
        if (action.kind === "openLinear") {
          void openIssue(action.identifier);
        } else if (action.kind === "openPr") {
          void vscode.env.openExternal(vscode.Uri.parse(action.url));
        } else if (action.kind === "signIn") {
          void signIn(context);
        } else if (action.kind === "bind" && worktree) {
          void bindIssue({ context, worktreeId: worktree.id });
        }
        /* Back to the list for the actions that left the window where it was. */
        handingOverToPreview = true;
        picker.show();
        picker.activeItems = restore;
        handingOverToPreview = false;
        void enterPicker();
      },
    });
    handingOverToPreview = false;
  };

  activePreviewTrigger = preview;
  /* Cycling rather than three absolute keys: Tab/Shift+Tab is how every other tab strip works, and
     it needs no digit to be free. alt+1/2/3 stays for jumping straight to one. */
  activeContextCycler = (step) => {
    const index = CONTEXTS.findIndex((entry) => entry.id === active);
    const next = CONTEXTS[(index + step + CONTEXTS.length) % CONTEXTS.length];
    if (next) applyContext(next.id);
  };

  picker.show();
  /* AFTER show(), not before: show() fires any other input UI's onDidHide, whose handler would
     clear a key set beforehand. */
  await enterPicker();
};

/* The command reads the active row off whichever surface is showing, held as ONE explicit
   reference — there is no way to pass the active row as a keybinding argument, and there are two
   surfaces. Nulled on hide so the command no-ops instead of touching a disposed object. */
let activePreviewTrigger: (() => Promise<void>) | undefined;
let activeContextCycler: ((step: number) => void) | undefined;

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

/* The worktree this window is open on, once git has said so. Held here because the sidebar's
   provider is registered before it is known — see the comment at that registration. */
let currentWorktree: Worktree | undefined;

export const activate = async (context: vscode.ExtensionContext) => {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const requireRoot = () => {
    if (root) return root;
    vscode.window.showWarningMessage("Aistos: no folder open.");
    return undefined;
  };

  const requireCurrent = async () => {
    const cwd = requireRoot();
    if (!cwd) return undefined;
    const resolved = await withCurrentWorktree({ root: cwd, announce: true });
    if (!resolved) {
      vscode.window.showWarningMessage("Aistos: this folder is not a git worktree.");
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
    ...CONTEXTS.map((entry) =>
      vscode.commands.registerCommand(
        entry.id === "worktrees"
          ? SHOW_WORKTREES_COMMAND
          : entry.id === "linear"
            ? SHOW_LINEAR_COMMAND
            : SHOW_PRS_COMMAND,
        () => {
          const cwd = requireRoot();
          if (!cwd) return;
          return showSwitcher({
            context,
            cwd,
            currentPath: cwd,
            initialContext: entry.id,
          });
        },
      ),
    ),
    vscode.commands.registerCommand("worktreeManager.github.signIn", async () => {
      if (await signInToGitHub()) {
        vscode.window.showInformationMessage("Signed in to GitHub.");
      }
    }),
    vscode.commands.registerCommand(PREVIEW_ISSUE_COMMAND, () => activePreviewTrigger?.()),
    vscode.commands.registerCommand(PREVIEW_BACK_COMMAND, () => closePreview()),
    vscode.commands.registerCommand(NEXT_CONTEXT_COMMAND, () => activeContextCycler?.(1)),
    vscode.commands.registerCommand(PREVIOUS_CONTEXT_COMMAND, () => activeContextCycler?.(-1)),
    vscode.commands.registerCommand(SIGN_IN_COMMAND, async () => {
      const token = await signIn(context);
      if (token) vscode.window.showInformationMessage("Signed in to Linear.");
    }),
    vscode.commands.registerCommand(SIGN_OUT_COMMAND, async () => {
      await signOut(context);
      vscode.window.showInformationMessage("Signed out of Linear. Cached issue data was cleared.");
    }),
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
        vscode.window.showInformationMessage("Aistos: no hook approvals are stored.");
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
        vscode.window.showInformationMessage("Aistos: no hook approvals are stored.");
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

  /* ABOVE the early returns below, and deliberately.

     The context key gates the view's `when` clause, so a key that is never set means the panel does
     not merely fail to render — it does not EXIST, and neither does the command that would reveal
     it. Both used to sit after `if (!root) return` and `if (!resolved) return`, so a window whose
     folder did not resolve as a worktree silently had no panel and a palette entry that did
     nothing, with no way to tell which was which. Nothing here needs a resolved worktree. */
  await publishLinearEnabled();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("worktreeManager.linear.workspace")) {
        void publishLinearEnabled();
      }
    }),
  );

  /* The identifier is resolved LAZILY rather than captured, so registering the provider does not
     have to wait on git: a provider registered after two awaited git calls loses the race when
     Source Control is already open, and the panel shows "no data provider registered" until a
     reload. */
  const issueView = createIssueView({
    context,
    resolveIdentifier: () =>
      currentWorktree &&
      identifierFor({
        context,
        worktreeId: currentWorktree.id,
        branch: currentWorktree.branch,
      }),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ISSUE_VIEW_ID, issueView),
    vscode.commands.registerCommand(REFRESH_ISSUE_COMMAND, () => issueView.refresh()),
    /* The panel is easy to miss inside Source Control, so an explicit command is the discoverable
       way in — and when the workspace setting is what is missing it says so, because that is the
       one reason the panel cannot appear at all. */
    vscode.commands.registerCommand(SHOW_ISSUE_COMMAND, async () => {
      if (!linearWorkspace()) {
        const answer = await vscode.window.showWarningMessage(
          "Set worktreeManager.linear.workspace to your Linear workspace slug — the panel cannot appear without it.",
          "Open settings",
        );
        if (answer) {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "worktreeManager.linear.workspace",
          );
        }
        return;
      }
      await vscode.commands.executeCommand("workbench.view.scm");
      issueView.reveal();
      await issueView.refresh();
    }),
    /* Refetch on focus, so a ticket updated in the browser is not stale in the panel — and so the
       signed image URLs are reminted before the old ones expire. */
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) void issueView.refresh();
    }),
  );
  onSignOut(() => issueView.forget());
  /* Signing out must clear what the credential fetched, in the same act — a revoked key with the
     rows it filled still in state.vscdb is the failure the retention rule exists to prevent. */
  onSignOut(() => clearCache(context));

  if (!root) return;

  const resolved = await withCurrentWorktree({ root, announce: false });
  if (!resolved) return;
  currentWorktree = resolved.current;
  void issueView.refresh();

  await rememberOpened({ context, id: resolved.current.id });
  const colours = await ensureColours({ context, worktrees: resolved.worktrees });
  const item = vscode.window.createStatusBarItem(
    "worktreeManager.current",
    vscode.StatusBarAlignment.Left,
    100,
  );
  item.name = "Aistos Worktree";

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
          'Aistos: no Linear issue on this branch. Bind one with "Aistos: Bind Linear Issue…".',
        );
        return;
      }
      return openIssue(identifier);
    }),
    vscode.commands.registerCommand(BIND_ISSUE_COMMAND, async () => {
      await bindIssue({ context, worktreeId: resolved.current.id });
      render();
      void issueView.refresh();
    }),
  );
};

/* Third clearing site, after onDidHide and the finally. If the extension is disabled or reloaded
   with the picker open, nothing else runs — and a key left set steals an arrow key workbench-wide
   with no API that can show which extension did it. */
export const deactivate = () => {
  void exitAll();
};
