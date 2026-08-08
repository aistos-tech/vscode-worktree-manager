import * as vscode from "vscode";
import { issueIdFor, issueUrl } from "./id";

const WORKSPACE_KEY = "worktreeManager.linear.workspace";
const OPEN_IN_KEY = "worktreeManager.linear.openIn";
const TEAM_KEYS_KEY = "worktreeManager.linear.teamKeys";
const BIND_KEY = "worktreeManager.linear.bindings";
export const LINEAR_ENABLED_CONTEXT = "worktreeManager.linearEnabled";

type Bindings = Record<string, string>;

export const linearWorkspace = () =>
  vscode.workspace.getConfiguration().get<string>(WORKSPACE_KEY, "").trim();

const openIn = () =>
  vscode.workspace.getConfiguration().get<string>(OPEN_IN_KEY, "browser") === "app"
    ? ("app" as const)
    : ("browser" as const);

const teamKeys = () => vscode.workspace.getConfiguration().get<string[]>(TEAM_KEYS_KEY, []);

/* A real context key, set at activation and on every change to the workspace setting. It is what
   makes "costs nothing to a user who never configures Linear" true rather than merely asserted:
   every Linear surface is gated on it, so with the setting unset none of them can fire. */
export const publishLinearEnabled = () =>
  vscode.commands.executeCommand("setContext", LINEAR_ENABLED_CONTEXT, Boolean(linearWorkspace()));

type IdentifyProps = {
  context: vscode.ExtensionContext;
  worktreeId: string;
  branch: string;
};

/* The branch is the source; the binding is the exception. 3 of 10 worktrees here carry no
   identifier — including the primary — so an override has to exist, but it stays an override
   rather than becoming a stored mapping that drifts. */
export const identifierFor = ({ context, worktreeId, branch }: IdentifyProps) => {
  const bound = context.workspaceState.get<Bindings>(BIND_KEY, {})[worktreeId];
  return bound ?? issueIdFor({ branch, teamKeys: teamKeys() });
};

export const bindIssue = async ({
  context,
  worktreeId,
}: {
  context: vscode.ExtensionContext;
  worktreeId: string;
}) => {
  const entered = await vscode.window.showInputBox({
    title: "Bind a Linear issue to this worktree",
    prompt: "Issue identifier, e.g. A-1661. Empty clears the binding.",
    validateInput: (value) =>
      !value.trim() || /^[a-z]{1,5}-\d+$/i.test(value.trim())
        ? undefined
        : "Expected an identifier like A-1661.",
  });
  if (entered === undefined) return;

  const bindings = { ...context.workspaceState.get<Bindings>(BIND_KEY, {}) };
  const trimmed = entered.trim().toUpperCase();
  if (trimmed) bindings[worktreeId] = trimmed;
  else delete bindings[worktreeId];
  await context.workspaceState.update(BIND_KEY, bindings);
};

export const openIssue = async (identifier: string) => {
  const workspace = linearWorkspace();
  if (!workspace) {
    vscode.window.showWarningMessage(
      `Set "${WORKSPACE_KEY}" to your Linear workspace slug to open ${identifier}.`,
    );
    return;
  }
  await vscode.env.openExternal(
    vscode.Uri.parse(issueUrl({ identifier, workspace, openIn: openIn() })),
  );
};

/* Appended to the existing status bar item rather than adding a second one: two items would mean
   two of everything, and the click stays bound to the switcher. The link goes in the tooltip,
   which is already a MarkdownString. */
export const badgeFor = (identifier: string | undefined) => (identifier ? ` · ${identifier}` : "");

/* ALWAYS the https form here, never the `linear://` deep link, and never with `isTrusted`.

   A MarkdownString rendered with `isTrusted` executes `command:` URIs, and this tooltip
   interpolates a BRANCH NAME — free text that git barely constrains, and that arrives from a PR's
   headRefName in the picker contexts. A branch called `x](command:workbench.action.terminal.new)`
   would render an executable link in the status bar. So the tooltip stays untrusted, which also
   means only well-known schemes render: `linear://` would be dropped, and the openIn preference is
   honoured by the openIssue COMMAND instead, where it costs nothing.

   The identifier is additionally safe by construction — it has already been through the
   `[a-z]{1,5}-\d+` pattern or the same-shaped bind validation, so it cannot carry markdown. */
export const tooltipLinkFor = (identifier: string | undefined) => {
  const workspace = linearWorkspace();
  if (!identifier || !workspace) return "";
  const url = issueUrl({ identifier, workspace, openIn: "browser" });
  return `\n\n[${identifier}](${url})`;
};
