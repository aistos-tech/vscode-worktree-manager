import * as vscode from "vscode";
import { fetchPullRequestForBranch } from "../github/client";
import { parseRemote } from "../github/remote";
import { originUrl } from "../worktree";
import { linearToken } from "./auth";
import { fetchIssueDetail, LinearError } from "./client";
import { bodyFor, escapeHtml, page, type RenderAction, shell } from "./render";

/* The → surface: a webview panel, using the SAME renderer as the sidebar.

   It replaced a native modal, which could not do three things this needs. A modal's `detail` is
   plain text by API — no markdown, no images, no links — so a ticket had to be flattened and then
   truncated to keep the dialog from outgrowing the screen. A panel scrolls, renders markdown
   through VS Code's own renderer, shows the images, and truncates nothing.

   The cost is that it is an editor tab rather than an overlay, so it has to clean up after itself:
   Escape closes it and hands control back to the picker. */

export const PANEL_TYPE = "aistos.preview";

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

type ShowProps = {
  context: vscode.ExtensionContext;
  target: PreviewTarget;
};

/* Resolves when the user picks an action or closes the panel. The caller decides what to do next,
   including whether to bring the picker back. */
export const showPreviewPanel = ({ context, target }: ShowProps) =>
  new Promise<PreviewAction | undefined>((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      PANEL_TYPE,
      target.identifier ?? target.worktreeName ?? "Preview",
      /* ⚠️ Active, NOT Beside. `Beside` splits the editor, and a split is a layout change that
         outlives the preview: the panel closes on the first action and leaves you with a second
         column you did not ask for and have to close by hand. A new tab in the column you were
         already in disappears with the panel and leaves the layout exactly as it was.

         The reason `Beside` was chosen first — not replacing the file you were reading — still
         holds, and a tab satisfies it just as well: the file stays open, one tab to the left. */
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: false },
    );

    let settled = false;
    const finish = (action: PreviewAction | undefined) => {
      if (settled) return;
      settled = true;
      panel.dispose();
      resolve(action);
    };

    const actions: RenderAction[] = [];
    const byId = new Map<string, PreviewAction>();
    const add = (id: string, label: string, key: string, action: PreviewAction) => {
      actions.push({ id, label, key });
      byId.set(id, action);
    };

    panel.onDidDispose(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    });

    panel.webview.onDidReceiveMessage((message: { id?: string }) => {
      if (!message.id) return;
      if (message.id === "__close") return finish(undefined);
      finish(byId.get(message.id));
    });

    const load = async () => {
      panel.webview.html = page({
        webview: panel.webview,
        body: shell("Loading…"),
      });

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
      if (settled) return;

      /* The primary action first, and it is always exactly one: go there, or make it. */
      if (target.worktreePath) {
        add("open", "Open worktree", "o", {
          kind: "openWorktree",
          path: target.worktreePath,
        });
      } else if (target.branch) {
        add("create", "Create worktree", "c", {
          kind: "createWorktree",
          branch: target.branch,
        });
      }
      if (target.identifier && signedIn) {
        add("linear", "Open in Linear", "l", {
          kind: "openLinear",
          identifier: target.identifier,
        });
      } else if (target.identifier) {
        add("signin", "Sign in to Linear", "s", { kind: "signIn" });
      }
      if (pr) add("pr", `Open PR #${pr.number}`, "p", { kind: "openPr", url: pr.url });

      const body = issue
        ? await bodyFor({ issue, pr })
        : [
            `<div class="title">${escapeHtml(target.identifier ?? target.branch ?? "Worktree")}</div>`,
            target.branch ? `<div class="meta">${escapeHtml(target.branch)}</div>` : "",
            shell(
              issueError
                ? issueError
                : target.identifier
                  ? signedIn
                    ? `${target.identifier} was not found in this workspace.`
                    : `Sign in to Linear to read ${target.identifier}.`
                  : "This branch carries no Linear issue.",
            ),
          ].join("");

      if (settled) return;
      panel.webview.html = page({ webview: panel.webview, body, actions });
    };

    void load();
  });
