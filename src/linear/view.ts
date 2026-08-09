import * as vscode from "vscode";
import { linearToken } from "./auth";
import { fetchIssueDetail, type IssueDetail, LinearError } from "./client";

export const ISSUE_VIEW_ID = "worktreeManager.issue";

/* Renders through VS Code's OWN markdown renderer — `markdown.api.render`, the command the built-in
   markdown extension exposes and activates on (`onCommand:markdown.api.render`). That removes the
   bundled markdown parser this feature was costed with, which would have been the extension's first
   runtime dependency, and it means ticket bodies render exactly like a markdown preview, including
   any markdown-it plugins the user has installed.

   It is not in the extension-authoring guide, so it is treated as semi-public: a failure falls back
   to escaped plain text rather than taking the panel down with it. */
const renderMarkdown = async (markdown: string) => {
  try {
    const html = await vscode.commands.executeCommand<string>("markdown.api.render", markdown);
    if (typeof html === "string") return html;
  } catch {
    /* falls through */
  }
  return `<pre class="fallback">${escapeHtml(markdown)}</pre>`;
};

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const nonceFor = () => {
  let value = "";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
};

/* The CSP is the real sanitiser, and it has to be, because markdown permits raw HTML and a Linear
   description is user-authored text from anyone with access to the workspace. `default-src 'none'`
   plus a nonced `script-src` blocks both `<script>` blocks and inline `onerror=`-style handlers, so
   an injected payload cannot execute even though it survives rendering. `img-src` is narrowed to
   Linear's own storage rather than opened to `https:`, so a body cannot beacon out to an arbitrary
   host by embedding an image. */
const cspFor = ({ webview, nonce }: { webview: vscode.Webview; nonce: string }) =>
  [
    "default-src 'none'",
    `img-src ${webview.cspSource} https://uploads.linear.app data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    /* 'none', not a nonce: scripts are disabled on the webview itself as well, so there is nothing
       legitimate to allow and every path is closed rather than merely narrowed. */
    "script-src 'none'",
    `font-src ${webview.cspSource}`,
  ].join("; ");

const STYLES = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); padding: 0 12px 24px; line-height: 1.55; }
  a { color: var(--vscode-textLink-foreground); }
  h1, h2, h3 { font-weight: 600; line-height: 1.3; }
  .identifier { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .title { font-size: 1.15em; font-weight: 600; margin: 2px 0 10px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
           border-radius: 10px; padding: 1px 8px; margin-right: 6px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 18px 0; }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  pre, code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
        overflow-x: auto; }
  table { border-collapse: collapse; } td, th { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .comment { border-left: 2px solid var(--vscode-panel-border); padding-left: 10px; margin: 14px 0; }
  .comment .who { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin-bottom: 2px; }
  .empty { color: var(--vscode-descriptionForeground); padding-top: 12px; }
  .fallback { white-space: pre-wrap; }
`;

const page = ({ webview, body }: { webview: vscode.Webview; body: string }) => {
  const nonce = nonceFor();
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${cspFor({ webview, nonce })}">
    <style nonce="${nonce}">${STYLES}</style></head><body>${body}</body></html>`;
};

const shell = (message: string) => `<p class="empty">${escapeHtml(message)}</p>`;

const bodyFor = async (issue: IssueDetail) => {
  const description = issue.description
    ? await renderMarkdown(issue.description)
    : '<p class="empty">No description.</p>';

  const comments = await Promise.all(
    issue.comments.nodes.map(async (comment) => {
      const who = escapeHtml(comment.user?.displayName ?? "Someone");
      const when = escapeHtml(new Date(comment.createdAt).toLocaleDateString());
      return `<div class="comment"><div class="who">${who} · ${when}</div>${await renderMarkdown(comment.body)}</div>`;
    }),
  );

  return [
    `<div class="identifier">${escapeHtml(issue.identifier)}</div>`,
    `<div class="title">${escapeHtml(issue.title)}</div>`,
    `<div class="meta"><span class="badge">${escapeHtml(issue.state.name)}</span>${escapeHtml(issue.assignee?.displayName ?? "unassigned")}</div>`,
    description,
    comments.length
      ? `<hr><div class="identifier">${comments.length} comment${comments.length === 1 ? "" : "s"}</div>${comments.join("")}`
      : "",
  ].join("");
};

type ResolveIdentifier = () => string | undefined;

export type IssueView = vscode.WebviewViewProvider & {
  reveal: () => void;
  refresh: () => Promise<void>;
  forget: () => void;
};

export const createIssueView = ({
  context,
  resolveIdentifier,
}: {
  context: vscode.ExtensionContext;
  resolveIdentifier: ResolveIdentifier;
}): IssueView => {
  let view: vscode.WebviewView | undefined;
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

    const identifier = resolveIdentifier();
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
      lastBody = await bodyFor(issue);
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
    forget: () => {
      lastBody = "";
      void refresh();
    },
  };
};
