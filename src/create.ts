import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as vscode from "vscode";
import { resolveHook, resolveWorktreesRoot } from "./config";
import { describeExit, type HookEnv, runHook } from "./hooks";
import { linearToken } from "./linear/auth";
import { LinearError, moveToStarted } from "./linear/client";
import { issueIdFor } from "./linear/id";
import { logInfo } from "./log";
import { toAbsolutePath } from "./paths";
import { setting } from "./settings";
import { ensureApproved } from "./trust";
import {
  addWorktree,
  branchExistsAnywhere,
  currentBranch,
  listBranches,
  listWorktrees,
  removeWorktreeAt,
  stderrOf,
  type Worktree,
} from "./worktree";

const BOOTSTRAP_CONSEQUENCE =
  "The post-create hook installs, builds and starts this repo's stack for the new worktree. " +
  "It can take minutes.";

type CreateProps = {
  context: vscode.ExtensionContext;
  gitCwd: string;
  worktrees: Worktree[];
  branchSeed?: string;
  /* What the caller believes this worktree is for. The PR tab passes "review"; every other caller
     leaves it unset and gets "work". The setting below can override both. */
  purpose?: HookEnv["WORKTREE_PURPOSE"];
};

const PURPOSE_KEY = "aistos.hooks.purpose";

/* The REPO decides what "review" skips — in debt-collection it drops the containers, the Postgres
   wait and the database seeding, which is the slow half of a bootstrap. The extension only decides
   which word to send.

   The default rule is per-tab: a row in the PR list is a branch you are about to read and delete,
   a row anywhere else is work. That is what "auto" means. "work" and "review" pin it, for anyone
   whose habits do not match — reviewing on their own branches, or wanting containers every time. */
const resolvePurpose = (requested: HookEnv["WORKTREE_PURPOSE"]) => {
  const configured = setting<string>(PURPOSE_KEY, "auto");
  return configured === "work" || configured === "review" ? configured : requested;
};

/* Between the last prompt and the finish toast, this flow used to show NOTHING for minutes. The
   hook does stream into a task terminal, but it opens with `focus: false` in a dedicated panel, so
   unless you already knew to look there the editor sat still and the create looked dead.

   One notification per long step, each disappearing when its step ends. Deliberately not a single
   notification held open across the whole flow: the two steps fail differently — `git worktree add`
   fails in seconds and is recoverable, the hook fails in minutes and leaves the worktree — and a
   progress bar that spans both says less than two that name what is running.

   Not cancellable, and that is not an oversight. Neither step is safely interruptible: killing
   `git worktree add` midway leaves a half-registered worktree, and killing the hook leaves a
   half-built stack the pre-delete hook then has to tear down. */
const withStep = <T>(message: string, run: () => Thenable<T>) => {
  logInfo(`create: ${message}`);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Aistos: ${message}`,
      cancellable: false,
    },
    run,
  );
};

const askBranch = (seed: string | undefined) =>
  vscode.window.showInputBox({
    title: "New worktree — branch",
    value: seed,
    prompt: "Existing branch to check out, or a new branch to create",
    validateInput: (value) => (value.trim() ? undefined : "Branch name is required."),
  });

const askSource = async (gitCwd: string) => {
  const [branches, current] = await Promise.all([listBranches(gitCwd), currentBranch(gitCwd)]);
  /* Current branch first: forking from where you are is the common case, and
     `--sort=-committerdate` alone does not guarantee it lands at the top. */
  const ordered = current
    ? [current, ...branches.filter((branch) => branch !== current)]
    : branches;
  return vscode.window.showQuickPick(ordered, {
    title: "New worktree — source branch to fork from",
  });
};

const askDest = (defaultPath: string) =>
  vscode.window.showInputBox({
    title: "New worktree — destination",
    value: defaultPath,
    valueSelection: [defaultPath.length - basename(defaultPath).length, defaultPath.length],
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!trimmed) return "Destination is required.";
      /* Same expansion as the accept path. Without it the box validated `/~/…`, found nothing
         there, and cheerfully reported the destination as free. */
      const path = toAbsolutePath(trimmed);
      return existsSync(path) ? `"${path}" already exists.` : undefined;
    },
  });

/* A non-zero `git worktree add` does NOT mean nothing happened. When the repo's post-checkout hook
   fails, git exits 1 having already created and registered the worktree — and debt-collection sets
   `assert_lefthook_installed: true` while a fresh worktree has no node_modules, so this is a live
   path. Surfacing the error and stopping would leave an orphan the user did not ask for and is not
   told about. */
const recoverFromAddFailure = async ({
  dest,
  gitCwd,
  reason,
}: {
  dest: string;
  gitCwd: string;
  reason: string;
}) => {
  const registered = await listWorktrees(gitCwd)
    .then((entries) => entries.some((entry) => resolve(entry.path) === resolve(dest)))
    .catch(() => false);
  if (!registered) {
    vscode.window.showErrorMessage(`git worktree add failed — ${reason}`);
    return false;
  }
  const answer = await vscode.window.showWarningMessage(
    "git worktree add reported an error, but the worktree exists.",
    {
      modal: true,
      detail: `${reason}\n\n${dest} is registered. This usually means the repo's post-checkout hook failed — a fresh worktree has no node_modules yet.`,
    },
    "Continue anyway",
    "Roll back",
  );
  if (answer === "Continue anyway") return true;
  if (answer === "Roll back") {
    try {
      await removeWorktreeAt({ path: dest, gitCwd, force: true });
      vscode.window.showInformationMessage(`Rolled back ${dest}.`);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not roll back ${dest} — ${stderrOf(error)}. Remove it by hand.`,
      );
    }
  }
  return false;
};

const SET_STARTED_KEY = "aistos.linear.setStartedOnCreate";

/* Runs only after the hook exits 0, and BEFORE the open prompt — a worktree whose bootstrap failed
   is not one you have started work in, and saying otherwise on the ticket is worse than saying
   nothing. Failures here are warnings, never errors: the worktree exists and is bootstrapped, and
   a ticket left in Backlog is a smaller problem than a create flow that appears to have failed. */
const markStarted = async ({
  context,
  branch,
}: {
  context: vscode.ExtensionContext;
  branch: string;
}) => {
  if (!setting(SET_STARTED_KEY, false)) {
    return;
  }
  const identifier = issueIdFor({ branch });
  if (!identifier) return;
  /* Never prompts for a credential here. Sign-in belongs to an explicit action, not to the tail of
     a create the user is waiting on. */
  if (!(await linearToken(context))) return;

  try {
    const result = await moveToStarted({ context, identifier });
    vscode.window.showInformationMessage(
      result.moved ? `Moved ${identifier} to started.` : `Left ${identifier} in ${result.state}.`,
    );
  } catch (error) {
    vscode.window.showWarningMessage(
      `Created the worktree, but could not update ${identifier} — ${error instanceof LinearError ? error.message : String(error)}`,
    );
  }
};

export const createWorktree = async ({
  context,
  gitCwd,
  worktrees,
  branchSeed,
  purpose = "work",
}: CreateProps) => {
  const branch = (await askBranch(branchSeed))?.trim();
  if (!branch) return;

  const existing = await branchExistsAnywhere(branch, gitCwd);

  /* Refuse before asking anything else: git would refuse at step 6 anyway, but only after the user
     has answered two more prompts, and the message would not name the occupant. */
  const occupied = worktrees.find((entry) => entry.branch === branch);
  if (occupied) {
    vscode.window.showErrorMessage(`"${branch}" is already checked out at ${occupied.path}.`);
    return;
  }

  /* Checkout mode skips the source prompt entirely — there is nothing to fork from. Keeping the
     two arms separate is what stops step 6 collapsing to `git worktree add <dest>`, which DWIMs a
     new branch from the dest basename instead of checking out the branch just found. */
  const source = existing ? undefined : await askSource(gitCwd);
  if (!existing && !source) return;

  const root = resolveWorktreesRoot(gitCwd);
  const raw = await askDest(join(root, basename(branch)));
  if (!raw) return;
  /* Expanded here too, not only in resolveWorktreesRoot: the destination is an input box the user
     can retype, and a tilde typed there hit exactly the same ENOENT. */
  const dest = toAbsolutePath(raw);

  /* The CLI this ports runs this unconditionally, ahead of its own existing/new branch. Without it
     a first worktree under a not-yet-created root fails with ENOENT rather than being created. */
  mkdirSync(dirname(dest), { recursive: true });

  try {
    await withStep(`Creating ${basename(dest)}…`, () =>
      addWorktree({ dest, branch, source, gitCwd }),
    );
  } catch (error) {
    const recovered = await recoverFromAddFailure({
      dest,
      gitCwd,
      reason: stderrOf(error),
    });
    if (!recovered) return;
  }

  const hook = resolveHook({ hook: "postCreate", primaryPath: gitCwd });
  if (hook.command) {
    const approved = await ensureApproved({
      context,
      primaryPath: gitCwd,
      command: hook.command,
      source: hook.source,
      consequence: BOOTSTRAP_CONSEQUENCE,
    });
    if (!approved) {
      /* Unlike preDelete, declining here is survivable: the worktree exists and is simply not
         bootstrapped, which is exactly what the bootstrap command is for. */
      vscode.window.showWarningMessage(
        `Created ${dest} without running the post-create hook. Run "Aistos: Bootstrap Worktree…" when you want it.`,
      );
      return;
    }
    const resolved = resolvePurpose(purpose);
    /* The purpose is in the title because it changes how long this takes by minutes, and a user
       watching a `review` bootstrap finish in seconds should not wonder what was skipped. */
    const exitCode = await withStep(`Bootstrapping ${basename(dest)} for ${resolved}…`, () =>
      runHook({
        command: hook.command,
        cwd: gitCwd,
        env: {
          WORKTREE_PATH: dest,
          WORKTREE_BRANCH: branch,
          WORKTREE_SOURCE: source ?? "",
          WORKTREE_PURPOSE: resolved,
        },
        name: `postCreate ${basename(dest)}`,
      }),
    );
    /* The worktree is KEPT on hook failure, matching the CLI — there is no rollback, and the
       bootstrap command is the retry. */
    if (exitCode !== 0) {
      vscode.window.showErrorMessage(
        `Post-create hook failed (${describeExit(exitCode)}). ${dest} was created but is not bootstrapped — check the "aistos" task panel, then retry with "Aistos: Bootstrap Worktree…".`,
      );
      return;
    }
  }

  await markStarted({ context, branch });

  /* Three-way, not a forced reopen. `forceReuseWindow` tears down the extension host AND the task
     terminal, so it would destroy the hook output the user may still want to read. */
  const opened = await vscode.window.showInformationMessage(
    `Worktree ready at ${dest}`,
    "Open",
    "Open in New Window",
    "Stay",
  );
  if (opened === "Open" || opened === "Open in New Window") {
    vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dest), {
      forceReuseWindow: opened === "Open",
    });
  }
};
