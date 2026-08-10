import type * as vscode from "vscode";
import { linearToken } from "./auth";
import { fetchIssueDetail, LinearError } from "./client";
import { bodyFor, page, shell } from "./render";

export const ISSUE_VIEW_ID = "worktreeManager.issue";

/* The sidebar shows the worktree you are IN, and shares its renderer with the → panel — same
   markdown, same CSP, same images. The only difference is that this one has no footer of actions:
   it is ambient, not a decision point. */

type ResolveIdentifier = () => string | undefined;

export type IssueView = vscode.WebviewViewProvider & {
  reveal: () => void;
  refresh: () => Promise<void>;
  forget: () => void;
  /* Points the panel at a row other than the current worktree, and `undefined` releases it. The
     modal can only render plain text, so this is where the rendered ticket — real markdown, real
     images — is one Escape away from the row you were looking at. */
  follow: (identifier: string | undefined) => Promise<void>;
};

export const createIssueView = ({
  context,
  resolveIdentifier,
}: {
  context: vscode.ExtensionContext;
  resolveIdentifier: ResolveIdentifier;
}): IssueView => {
  let view: vscode.WebviewView | undefined;
  let followed: string | undefined;
  /* Last rendered body, so a reopened window is not blank while the refetch runs, and an offline
     window still shows the ticket it last had. In memory only — it dies with the window rather
     than becoming ticket text at rest. */
  let lastBody = "";

  const paint = (body: string) => {
    if (!view) return;
    view.webview.html = page({ webview: view.webview, body });
  };

  const refresh = async () => {
    if (!view) return;

    const identifier = followed ?? resolveIdentifier();
    if (!identifier) {
      paint(shell("This worktree's branch carries no Linear issue."));
      return;
    }
    view.title = identifier;

    if (!(await linearToken(context))) {
      paint(shell(`${identifier} — sign in to Linear to read it.`));
      return;
    }

    /* Paints the last body first, so a refresh is not a flash of blank panel. */
    if (lastBody) paint(lastBody);

    try {
      const issue = await fetchIssueDetail({ context, identifier });
      if (!issue) {
        paint(shell(`${identifier} was not found in this workspace.`));
        return;
      }
      lastBody = await bodyFor({ issue });
      paint(lastBody);
    } catch (error) {
      const message = error instanceof LinearError ? error.message : String(error);
      /* Never a silently empty panel: the reason is rendered, with any warm body kept beneath it. */
      paint(`${shell(message)}${lastBody}`);
    }
  };

  return {
    resolveWebviewView: (resolved) => {
      view = resolved;
      /* No localResourceRoots, because nothing is served from disk: images come straight from
         Linear's storage as signed URLs, so there is no cache directory to expose and no ticket
         data at rest to retain, cap or delete on sign-out. */
      resolved.webview.options = { enableScripts: false };
      void refresh();
      resolved.onDidChangeVisibility(() => {
        if (resolved.visible) void refresh();
      });
    },
    /* preserveFocus: revealing the ticket must not steal the keyboard from whatever asked for it. */
    reveal: () => view?.show?.(true),
    refresh,
    follow: async (identifier) => {
      followed = identifier;
      lastBody = "";
      await refresh();
    },
    forget: () => {
      lastBody = "";
      void refresh();
    },
  };
};
