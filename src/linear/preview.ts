import * as vscode from "vscode";
import { fetchPullRequestForBranch } from "../github/client";
import { parseRemote } from "../github/remote";
import { enterPreview, exitPreview } from "../picker/context-keys";
import { originUrl } from "../worktree";
import { linearToken } from "./auth";
import { fetchIssue, LinearError } from "./client";
import { digestFor, escapeIcons } from "./digest";

/* The → surface. One view for every context, because a row means the same thing whichever tab you
   reached it from: a unit of work, which may have a worktree, a Linear issue and a pull request.
   Showing a different subset per tab would make the gesture's result depend on where you came from.

   Actions first, then context. The action is why the popup was opened — you pressed → to decide
   whether to go there — so it should not be below three lines of prose you have to read past.

   Scalar rows only: QuickPickItem carries no markdown and `detail` does not wrap, so a body digest
   would put a silently ellipsis-truncated sentence one keystroke from the trash button. The sidebar
   renders the body properly; this answers "is this the thing I think it is". */

export type PreviewTarget = {
  /* What the row is about. Any of these may be absent — a branch with no issue, an issue with no
     worktree, a worktree with no PR are all ordinary. */
  identifier: string | undefined;
  branch: string | undefined;
  worktreePath: string | undefined;
  worktreeName: string | undefined;
  /* Where git lives, for the PR lookup. */
  gitCwd: string;
};

type Action =
  | { kind: "openWorktree"; path: string }
  | { kind: "createWorktree"; branch: string }
  | { kind: "openLinear"; identifier: string }
  | { kind: "openPr"; url: string }
  | { kind: "bind" }
  | { kind: "signIn" };

type Row = vscode.QuickPickItem & { action?: Action };

type PreviewProps = {
  context: vscode.ExtensionContext;
  target: PreviewTarget;
  onBack: () => void;
  onAction: (action: Action) => void;
};

const separator = (label: string): Row => ({
  label,
  kind: vscode.QuickPickItemKind.Separator,
});

const describePrState = (pr: {
  state: string;
  isDraft: boolean;
  reviewDecision: string | undefined;
}) =>
  [
    pr.isDraft ? "draft" : pr.state.toLowerCase(),
    pr.reviewDecision === "APPROVED"
      ? "approved"
      : pr.reviewDecision === "CHANGES_REQUESTED"
        ? "changes requested"
        : pr.reviewDecision === "REVIEW_REQUIRED"
          ? "review required"
          : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

/* The row that is always first, and is always an action. "Open" is the verb because that is what
   pressing Enter does; a row labelled with a worktree name alone reads as a heading. */
const primaryAction = (target: PreviewTarget): Row => {
  if (target.worktreePath && target.worktreeName) {
    return {
      label: `$(folder-opened) Open worktree ${escapeIcons(target.worktreeName)}`,
      detail: target.worktreePath,
      alwaysShow: true,
      action: { kind: "openWorktree", path: target.worktreePath },
    };
  }
  if (target.branch) {
    return {
      label: `$(add) Create worktree for ${escapeIcons(target.branch)}`,
      detail: "No worktree exists for this branch yet",
      alwaysShow: true,
      action: { kind: "createWorktree", branch: target.branch },
    };
  }
  return {
    label: "$(link) Bind a Linear issue…",
    detail: "This row has no branch to act on",
    alwaysShow: true,
    action: { kind: "bind" },
  };
};

/* Held at module scope for the same reason the picker's trigger is: a keybinding cannot carry the
   surface it should act on, and there is only ever one preview. Cleared on every exit so the
   command no-ops rather than touching a disposed object. */
let activePreviewBack: (() => void) | undefined;

export const closePreview = () => activePreviewBack?.();

export const showIssuePreview = async ({ context, target, onBack, onAction }: PreviewProps) => {
  const preview = vscode.window.createQuickPick<Row>();
  preview.busy = true;
  preview.keepScrollPosition = true;
  preview.buttons = [vscode.QuickInputButtons.Back];
  preview.title = target.identifier ?? target.worktreeName ?? "Worktree";
  preview.placeholder = "Enter to act · Back or Escape to return";

  let done = false;
  const finish = (action?: Action) => {
    if (done) return;
    done = true;
    activePreviewBack = undefined;
    void exitPreview();
    preview.dispose();
    if (action) onAction(action);
    else onBack();
  };

  preview.onDidTriggerButton((button) => {
    if (button === vscode.QuickInputButtons.Back) finish();
  });
  /* ← closes the popup. The earlier argument for leaving it unbound was that typing in the filter
     box re-sorts the rows, so the user needs cursor-left to undo what they typed — that held for a
     body digest you might search. These are five scalar rows nobody filters, and → cannot be undone
     with anything else without reaching for a chord. */
  activePreviewBack = () => finish();
  preview.onDidHide(() => finish());
  preview.onDidAccept(() => {
    const [selected] = preview.selectedItems;
    if (selected?.action) finish(selected.action);
  });

  const base = primaryAction(target);
  preview.items = [base];
  preview.show();
  await enterPreview();

  /* Both lookups run together: they are independent, and doing them in sequence would make the
     popup's fill-in take as long as the slower one plus the faster one. */
  const signedIn = Boolean(await linearToken(context));
  const remote = parseRemote(await originUrl(target.gitCwd));
  let issueError: string | undefined;
  const [issue, pr] = await Promise.all([
    target.identifier && signedIn
      ? fetchIssue({ context, identifier: target.identifier }).catch((error: unknown) => {
          issueError = error instanceof LinearError ? error.message : String(error);
          return undefined;
        })
      : Promise.resolve(undefined),
    remote && target.branch
      ? fetchPullRequestForBranch({ ...remote, branch: target.branch }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  if (done) return;
  preview.busy = false;

  const contextRows: Row[] = [];

  if (target.identifier && !signedIn) {
    contextRows.push({
      label: "$(key) Sign in to Linear",
      detail: `${escapeIcons(target.identifier)} — a credential is needed to read it`,
      alwaysShow: true,
      action: { kind: "signIn" },
    });
  } else if (issueError) {
    contextRows.push({
      label: `$(warning) ${escapeIcons(issueError)}`,
      alwaysShow: true,
    });
  } else if (issue) {
    /* The digest's own last row is "Open in Linear", which belongs in the actions block below. */
    contextRows.push(
      ...digestFor(issue)
        .slice(0, -1)
        .map<Row>((row) => ({ ...row, alwaysShow: true })),
    );
  } else if (target.identifier) {
    contextRows.push({
      label: `$(question) ${escapeIcons(target.identifier)} — not found in this workspace`,
      alwaysShow: true,
    });
  }

  if (pr) {
    contextRows.push({
      label: `$(git-pull-request) #${pr.number} ${escapeIcons(pr.title)}`,
      description: describePrState(pr),
      alwaysShow: true,
    });
  }

  const trailing: Row[] = [];
  if (target.identifier) {
    trailing.push({
      label: "$(link-external) Open in Linear",
      alwaysShow: true,
      action: { kind: "openLinear", identifier: target.identifier },
    });
  }
  if (pr) {
    trailing.push({
      label: `$(github) Open PR #${pr.number}`,
      alwaysShow: true,
      action: { kind: "openPr", url: pr.url },
    });
  }
  if (!target.identifier) {
    trailing.push({
      label: "$(link) Bind a Linear issue…",
      alwaysShow: true,
      action: { kind: "bind" },
    });
  }

  /* Restores the highlight to the action row rather than leaving it wherever the reassignment put
     it: the first row is what Enter should hit. */
  preview.items = [
    base,
    ...(contextRows.length ? [separator(""), ...contextRows] : []),
    ...(trailing.length ? [separator(""), ...trailing] : []),
  ];
  preview.activeItems = [base];
};
