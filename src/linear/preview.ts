import * as vscode from "vscode";
import { fetchPullRequestForBranch } from "../github/client";
import { parseRemote } from "../github/remote";
import { originUrl } from "../worktree";
import { linearToken } from "./auth";
import { fetchIssueDetail, LinearError } from "./client";
import { modalBody } from "./text";

/* The → surface: a real modal, not a second QuickPick.

   The QuickPick version could only hold selectable rows, so a ticket's state and assignee sat in a
   list whose entire affordance is "press Enter on me" while doing nothing — and the description,
   the part you actually want to read, could not be shown at all, because `detail` does not wrap and
   would truncate a sentence mid-clause one keystroke from the trash button.

   A modal separates the two properly: content is text you read, actions are buttons you press.
   The cost is that `detail` renders as PLAIN text — no markdown, no images, no links — which is
   what `text.ts` exists to flatten, and roughly three buttons before the dialog looks cramped. The
   sidebar remains the surface for the full rendered ticket. */

export type PreviewTarget = {
  identifier: string | undefined;
  branch: string | undefined;
  worktreePath: string | undefined;
  worktreeName: string | undefined;
  gitCwd: string;
};

export type PreviewAction =
  | { kind: "openWorktree"; path: string }
  | { kind: "createWorktree"; branch: string }
  | { kind: "openLinear"; identifier: string }
  | { kind: "openPr"; url: string }
  | { kind: "signIn" };

type PreviewProps = {
  context: vscode.ExtensionContext;
  target: PreviewTarget;
};

/* Returns the action the user chose, or undefined if they dismissed. The caller decides what to do
   and, crucially, what to do about the picker — which the modal hid on the way in. */
export const showPreviewModal = async ({
  context,
  target,
}: PreviewProps): Promise<PreviewAction | undefined> => {
  const signedIn = Boolean(await linearToken(context));

  const remote = parseRemote(await originUrl(target.gitCwd));
  let issueError: string | undefined;
  const [issue, pr] = await Promise.all([
    target.identifier && signedIn
      ? fetchIssueDetail({ context, identifier: target.identifier }).catch((error: unknown) => {
          issueError = error instanceof LinearError ? error.message : String(error);
          return undefined;
        })
      : Promise.resolve(undefined),
    remote && target.branch
      ? fetchPullRequestForBranch({ ...remote, branch: target.branch }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  const { message, detail } = modalBody({
    identifier: target.identifier,
    title: issue?.title,
    state: issue?.state.name,
    assignee: issue?.assignee?.displayName ?? undefined,
    description: issue?.description ?? undefined,
    pr: pr ? { number: pr.number, state: pr.state } : undefined,
    branch: target.branch,
  });

  /* Buttons in the order you are most likely to want them, capped at three so the dialog does not
     wrap its button row. The primary action always comes first. */
  const buttons: { label: string; action: PreviewAction }[] = [];
  if (target.worktreePath) {
    buttons.push({
      label: "Open worktree",
      action: { kind: "openWorktree", path: target.worktreePath },
    });
  } else if (target.branch) {
    buttons.push({
      label: "Create worktree",
      action: { kind: "createWorktree", branch: target.branch },
    });
  }
  if (target.identifier && signedIn) {
    buttons.push({
      label: "Open in Linear",
      action: { kind: "openLinear", identifier: target.identifier },
    });
  } else if (target.identifier) {
    buttons.push({ label: "Sign in to Linear", action: { kind: "signIn" } });
  }
  if (pr) {
    buttons.push({ label: `Open PR #${pr.number}`, action: { kind: "openPr", url: pr.url } });
  }

  const shown = issueError ? `${detail}\n\n⚠ ${issueError}`.trim() : detail;
  const picked = await vscode.window.showInformationMessage(
    message,
    { modal: true, detail: shown || "Nothing to show for this row." },
    ...buttons.map((button) => button.label),
  );
  return buttons.find((button) => button.label === picked)?.action;
};
