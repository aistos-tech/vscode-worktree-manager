import * as vscode from "vscode";
import type { IssueDetail } from "./client";

/* The one renderer. The sidebar and the → panel are the same HTML with the same CSP and the same
   markdown, differing only in whether a footer of actions is appended — which is the point: two
   renderers over one input would drift, and a checklist that renders in one and not the other is
   exactly the kind of difference nobody notices until it matters. */

export type RenderAction = {
  id: string;
  label: string;
  /* Single character, matched case-insensitively. Shown on the button, so the shortcut is
     discoverable rather than something you have to be told. */
  key: string;
};

/* Renders through VS Code's OWN markdown renderer — the command the built-in markdown extension
   exposes and activates on. No bundled parser, and bodies render exactly like a markdown preview,
   including any markdown-it plugins the user has. It is absent from the authoring guide, so a
   failure degrades to escaped plain text rather than taking the surface down. */
const renderMarkdown = async (markdown: string) => {
  try {
    const html = await vscode.commands.executeCommand<string>("markdown.api.render", markdown);
    if (typeof html === "string") return html;
  } catch {
    /* falls through */
  }
  return `<pre class="fallback">${escapeHtml(markdown)}</pre>`;
};

export const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const nonceFor = () => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
};

/* The CSP is the sanitiser, and it has to be: markdown permits raw HTML and a ticket body is text
   written by anyone with workspace access. A nonced `script-src` admits only the script written
   here, so an injected `<script>` or inline `onerror=` cannot execute even though it survives
   rendering — and `img-src` is narrowed to Linear's own storage rather than opened to `https:`, so
   a body cannot beacon out by embedding a remote image. */
const cspFor = ({ webview, nonce }: { webview: vscode.Webview; nonce: string }) =>
  [
    "default-src 'none'",
    `img-src ${webview.cspSource} https://uploads.linear.app data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");

const STYLES = `
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         color: var(--vscode-foreground); line-height: 1.55; margin: 0;
         display: flex; flex-direction: column; }
  /* The body scrolls, the footer does not — the whole reason this exists rather than a modal. */
  .scroll { flex: 1 1 auto; overflow-y: auto; padding: 14px 16px 20px; }
  a { color: var(--vscode-textLink-foreground); }
  h1, h2, h3 { font-weight: 600; line-height: 1.3; }
  .identifier { color: var(--vscode-descriptionForeground);
                font-family: var(--vscode-editor-font-family); }
  .title { font-size: 1.2em; font-weight: 600; margin: 2px 0 10px; }
  .meta { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
  .badge { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
           border-radius: 10px; padding: 1px 8px; margin-right: 6px; }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 18px 0; }
  img { max-width: 100%; height: auto; border-radius: 4px; }
  pre, code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px;
        overflow-x: auto; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  ul.contains-task-list { list-style: none; padding-left: 1.1em; }
  .comment { border-left: 2px solid var(--vscode-panel-border); padding-left: 10px; margin: 14px 0; }
  .comment .who { color: var(--vscode-descriptionForeground); font-size: .92em; margin-bottom: 2px; }
  .empty { color: var(--vscode-descriptionForeground); }
  .fallback { white-space: pre-wrap; }
  footer { flex: 0 0 auto; display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 16px;
           border-top: 1px solid var(--vscode-panel-border);
           background: var(--vscode-sideBar-background); }
  button { font-family: inherit; font-size: inherit; cursor: pointer; border: none;
           border-radius: 3px; padding: 5px 12px;
           background: var(--vscode-button-secondaryBackground);
           color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background);
                   color: var(--vscode-button-foreground); }
  button:hover { filter: brightness(1.1); }
  button kbd { opacity: .7; margin-left: 6px; font-family: var(--vscode-editor-font-family);
               font-size: .9em; }
`;

type PageProps = {
  webview: vscode.Webview;
  body: string;
  actions?: RenderAction[];
};

export const page = ({ webview, body, actions = [] }: PageProps) => {
  const nonce = nonceFor();
  const footer = actions.length
    ? `<footer>${actions
        .map(
          (action, index) =>
            `<button class="${index === 0 ? "primary" : ""}" data-id="${escapeHtml(action.id)}">${escapeHtml(action.label)}<kbd>${escapeHtml(action.key.toUpperCase())}</kbd></button>`,
        )
        .join("")}</footer>`
    : "";
  /* Accelerators live in the page rather than as VS Code keybindings: a webview has focus while it
     is open, so a `when`-scoped binding would need a context key per panel, and the letters are
     already printed on the buttons. Escape closes, which is what a reader reaches for. */
  const script = actions.length
    ? `<script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        const send = (id) => vscodeApi.postMessage({ id });
        for (const button of document.querySelectorAll("button")) {
          button.addEventListener("click", () => send(button.dataset.id));
        }
        const keys = ${JSON.stringify(Object.fromEntries(actions.map((a) => [a.key.toLowerCase(), a.id])))};
        window.addEventListener("keydown", (event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === "Escape") return send("__close");
          const id = keys[event.key.toLowerCase()];
          if (id) { event.preventDefault(); send(id); }
        });
      </script>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${cspFor({ webview, nonce })}">
    <style nonce="${nonce}">${STYLES}</style></head>
    <body><div class="scroll">${body}</div>${footer}${script}</body></html>`;
};

export const shell = (message: string) => `<p class="empty">${escapeHtml(message)}</p>`;

type BodyProps = {
  issue: IssueDetail;
  pr?: { number: number; state: string; url: string } | undefined;
};

/* Description AND comments, in full. Nothing is truncated here — this surface scrolls, which is
   precisely why it exists. A ticket's decisions accumulate in its comments, so rendering only the
   description shows the stalest part of it. */
export const bodyFor = async ({ issue, pr }: BodyProps) => {
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
    `<div class="meta"><span class="badge">${escapeHtml(issue.state.name)}</span>${escapeHtml(issue.assignee?.displayName ?? "unassigned")}${
      pr ? ` · PR #${pr.number} ${escapeHtml(pr.state.toLowerCase())}` : ""
    }</div>`,
    description,
    comments.length
      ? `<hr><div class="identifier">${comments.length} comment${comments.length === 1 ? "" : "s"}</div>${comments.join("")}`
      : "",
  ].join("");
};
