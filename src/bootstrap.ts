import { basename } from "node:path";
import * as vscode from "vscode";
import { resolveHook } from "./config";
import { describeExit, type HookEnv, runHook } from "./hooks";
import { acquireWorktreeLock } from "./lock";
import { ensureApproved } from "./trust";
import type { Worktree } from "./worktree";

/* The extension cannot enumerate what a repo's hook overwrites — that list lives in the repo, and
   hand-writing one here would drift the moment the repo adds a file. So the modal is explicit about
   the CLASS of damage and names the command, and leaves the specifics to the repo's own docs. This
   is deliberately blunt: on debt-collection this rewrites every generated .env, the MCP config, the
   local Claude settings and the seed dump, and resets the dev and test databases — all gitignored,
   so there is no git recovery and no undo. */
const REBOOTSTRAP_DETAIL =
  "This re-runs the repo's post-create hook against an EXISTING worktree.\n\n" +
  "It is not a repair: a bootstrap rewrites the generated config a worktree owns — env files, " +
  "local tool config, seed data — and may reset its databases. Those files are gitignored, so " +
  "hand edits are lost with no git recovery.\n\n" +
  "Anything running in that worktree should be stopped first.";

type BootstrapProps = {
  context: vscode.ExtensionContext;
  worktree: Worktree;
  primaryPath: string;
};

/* `work` vs `review` has no other producer. Create always means work, and a PR worktree checked out
   by another extension will never set it — so without this the repo-side branch on it is dead code. */
const askPurpose = async (): Promise<HookEnv["WORKTREE_PURPOSE"] | undefined> => {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(tools) Bootstrap for work",
        detail: "Full bootstrap — install, build, containers, databases",
        purpose: "work" as const,
      },
      {
        label: "$(beaker) Bootstrap for review",
        detail: "The repo may skip the slow parts for a worktree you will read and delete",
        purpose: "review" as const,
      },
    ],
    { title: "How should this worktree be bootstrapped?" },
  );
  return picked?.purpose;
};

export const bootstrapWorktree = async ({ context, worktree, primaryPath }: BootstrapProps) => {
  const name = basename(worktree.path);

  /* Defence at both ends: the repo-side bootstrap refuses the primary on its own, and the button
     is not offered on the primary's row. Neither alone is enough — the command is also in the
     palette, where no row is involved. */
  if (worktree.isMain) {
    vscode.window.showErrorMessage(
      "Refusing to bootstrap the primary worktree — that would rewrite its own env and reset its databases.",
    );
    return;
  }

  const hook = resolveHook({ hook: "postCreate", primaryPath });
  if (!hook.command) {
    vscode.window.showInformationMessage(
      "Aistos: this repo has no post-create hook, so there is nothing to run.",
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Re-bootstrap "${name}"?`,
    { modal: true, detail: `${hook.command}\n\n${REBOOTSTRAP_DETAIL}` },
    "Bootstrap",
  );
  if (confirmed !== "Bootstrap") return;

  const purpose = await askPurpose();
  if (!purpose) return;

  const approved = await ensureApproved({
    context,
    primaryPath,
    command: hook.command,
    source: hook.source,
    consequence: REBOOTSTRAP_DETAIL,
  });
  if (!approved) return;

  /* Two `$(sync)` clicks in two windows would otherwise run concurrent `bun install` in one
     node_modules, and a bootstrap racing a delete is worse still. */
  const lock = acquireWorktreeLock({
    primaryPath,
    id: worktree.id,
    operation: `bootstrap ${name}`,
  });
  if (!lock.acquired) {
    vscode.window.showErrorMessage(
      `Another window is already running "${lock.heldBy}" on "${name}". Wait for it to finish.`,
    );
    return;
  }

  const exitCode = await runHook({
    command: hook.command,
    cwd: primaryPath,
    env: {
      WORKTREE_PATH: worktree.path,
      WORKTREE_BRANCH: worktree.branch,
      WORKTREE_SOURCE: "",
      WORKTREE_PURPOSE: purpose,
    },
    name: `bootstrap ${name}`,
  }).finally(() => lock.release());

  /* Reports BOTH outcomes. The task panel is opened with focus:false, so a silent failure here
     would be invisible — after the hook has already rewritten .env and possibly reset a database. */
  if (exitCode === 0) {
    vscode.window.showInformationMessage(`Bootstrapped "${name}".`);
    return;
  }
  vscode.window.showErrorMessage(
    `Bootstrap of "${name}" failed (${describeExit(exitCode)}). It may be half-configured — check the "aistos" task panel.`,
  );
};
