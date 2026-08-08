import * as vscode from "vscode";
import { enterPreview, exitPreview } from "../picker/context-keys";
import { linearToken } from "./auth";
import { openIssue } from "./badge";
import { fetchIssue, LinearError } from "./client";
import { digestFor, escapeIcons } from "./digest";

/* The → popup. A second QuickPick, because it is the only surface that is literally a popup, is
   instant, keeps focus, and returns you to the list.

   Deliberately NOT a body digest. QuickPickItem carries no markdown and `detail` does not wrap — a
   long line truncates with an ellipsis — so rendering prose here would put a silently-cut sentence
   one row away from the trash button. Scalar fields only; `Open in Linear` covers the rest. This
   also keeps the extension free of a markdown parser, which would be its first runtime dependency. */

type PreviewProps = {
  context: vscode.ExtensionContext;
  identifier: string | undefined;
  onBack: () => void;
};

type Row = vscode.QuickPickItem & { action?: "bind" | "signIn" | "open" };

const rowsForError = (message: string): Row[] => [
  { label: `$(warning) ${escapeIcons(message)}`, alwaysShow: true },
];

export const showIssuePreview = async ({ context, identifier, onBack }: PreviewProps) => {
  const preview = vscode.window.createQuickPick<Row>();
  preview.ignoreFocusOut = false;
  preview.busy = true;
  preview.buttons = [vscode.QuickInputButtons.Back];
  preview.title = identifier ?? "Linear";

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    void exitPreview();
    preview.dispose();
    onBack();
  };

  preview.onDidTriggerButton((button) => {
    if (button === vscode.QuickInputButtons.Back) finish();
  });
  /* Cleared before dispose and on every exit path — a previewOpen left set gates a RightArrow
     binding at extension weight and would steal the key workbench-wide. */
  preview.onDidHide(() => finish());

  preview.onDidAccept(() => {
    const [selected] = preview.selectedItems;
    if (selected?.action === "signIn") {
      finish();
      void vscode.commands.executeCommand("worktreeManager.linear.signIn");
      return;
    }
    if (selected?.action === "bind") {
      finish();
      void vscode.commands.executeCommand("worktreeManager.linear.bindIssue");
      return;
    }
    if (selected?.action === "open" && identifier) {
      finish();
      void openIssue(identifier);
    }
  });

  preview.show();
  await enterPreview();

  /* The degradation table. Every state renders a ROW that says what to do next — never an empty
     popup, and never an error toast. "No issue" is the common case here, not an edge: the primary
     worktree normally carries no identifier. */
  if (!identifier) {
    preview.busy = false;
    preview.items = [
      {
        label: "$(link) Bind a Linear issue…",
        detail: "This branch carries no issue identifier",
        action: "bind",
        alwaysShow: true,
      },
    ];
    return;
  }

  if (!(await linearToken(context))) {
    preview.busy = false;
    preview.items = [
      {
        label: "$(key) Sign in to Linear",
        detail: `${escapeIcons(identifier)} — a credential is needed to read it`,
        action: "signIn",
        alwaysShow: true,
      },
    ];
    return;
  }

  try {
    const issue = await fetchIssue({ context, identifier });
    if (done) return;
    preview.busy = false;
    if (!issue) {
      /* The "confident badge linking to a 404" failure, surfaced honestly rather than as a link
         that silently goes nowhere. */
      preview.items = [
        {
          label: `$(question) ${escapeIcons(identifier)} — not found`,
          detail: "The branch looks like an issue, but this workspace has no such issue",
          alwaysShow: true,
        },
        { label: "$(link) Bind a different issue…", action: "bind", alwaysShow: true },
      ];
      return;
    }
    preview.items = [
      ...digestFor(issue).map<Row>((row, index, all) => ({
        label: row.label,
        description: row.description,
        detail: row.detail,
        alwaysShow: true,
        ...(index === all.length - 1 ? { action: "open" as const } : {}),
      })),
    ];
  } catch (error) {
    if (done) return;
    preview.busy = false;
    preview.items = rowsForError(error instanceof LinearError ? error.message : String(error));
  }
};
