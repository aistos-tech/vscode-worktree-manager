import * as vscode from "vscode";

export const HOOK_TASK_TYPE = "worktreeManager.hook";

export type HookEnv = {
  WORKTREE_PATH: string;
  WORKTREE_BRANCH: string;
  WORKTREE_SOURCE: string;
  WORKTREE_PURPOSE: "work" | "review";
};

type RunHookProps = {
  command: string;
  cwd: string;
  env: HookEnv;
  name: string;
};

let nonceCounter = 0;

/* Runs the hook as a programmatic vscode.Task rather than in a terminal, because a Task yields a
   real exit code through onDidEndTaskProcess with no dependency on shell integration, while still
   streaming into the panel. Reading tasks.json was rejected separately: `${input:}` cannot be
   filled programmatically, so the clicked row's path could never reach the task. */
export const runHook = ({ command, cwd, env, name }: RunHookProps) => {
  /* An empty command is "this repo has no hook", and resolves 0 so other repos are wholly
     unaffected. A DECLINED hook is not this case and must not reach here — see trust.ts. */
  if (!command) return Promise.resolve<number>(0);

  nonceCounter += 1;
  const nonce = `${Date.now()}-${nonceCounter}`;

  const task = new vscode.Task(
    /* The nonce rides in the TaskDefinition, which onDidEndTaskProcess hands back as
       e.execution.task.definition — not in the task name, where it would be user-visible noise in
       the panel. Object identity is not reliable for matching here. */
    { type: HOOK_TASK_TYPE, nonce },
    vscode.TaskScope.Workspace,
    name,
    "worktree",
    new vscode.ShellExecution(command, {
      cwd,
      /* ShellExecutionOptions.env is MERGED with the parent process environment, verbatim per the
         typings — it cannot subtract. So this adds the contract and does not pretend to be a
         sandbox: GITHUB_TOKEN and friends reach the hook regardless, and the trust approval is the
         only real mitigation. A repo that wants isolation writes `env -i …` into its own command
         string; the extension cannot enforce it, because the command belongs to the repo. */
      env: { ...env },
    }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    focus: false,
  };

  return new Promise<number | undefined>((resolve) => {
    let settled = false;
    let sawProcessEnd = false;

    const finish = (code: number | undefined) => {
      if (settled) return;
      settled = true;
      endProcess.dispose();
      endTask.dispose();
      resolve(code);
    };

    const isOurs = (execution: vscode.TaskExecution) =>
      execution.task.definition.type === HOOK_TASK_TYPE &&
      execution.task.definition.nonce === nonce;

    /* Subscribed BEFORE executeTask: the promise it returns can resolve after the event has
       already fired for a fast-failing hook, and subscribing afterwards misses it entirely — the
       flow then hangs forever. */
    const endProcess = vscode.tasks.onDidEndTaskProcess((event) => {
      if (!isOurs(event.execution)) return;
      sawProcessEnd = true;
      /* exitCode is `number | undefined` even on the happy path. undefined is treated as FAILURE:
         inverting this makes preDelete silently succeed and leak the stack, which is precisely the
         bug the hook exists to prevent. */
      finish(event.exitCode);
    });

    /* onDidEndTaskProcess is not guaranteed to fire — it needs a process to have spawned, and a bad
       cwd or a rejected task fires only onDidEndTask. Awaiting both would never settle in exactly
       that case, wedging a delete with the modal already confirmed; racing them would report a
       successful hook as a failure whenever onDidEndTask won. So: resolve undefined here ONLY if no
       process-end was seen. */
    const endTask = vscode.tasks.onDidEndTask((event) => {
      if (!isOurs(event.execution)) return;
      if (sawProcessEnd) return;
      finish(undefined);
    });

    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      vscode.window.showErrorMessage(
        `Worktree Manager: could not start the hook — ${error instanceof Error ? error.message : String(error)}`,
      );
      finish(undefined);
    });
  });
};

export const describeExit = (code: number | undefined) =>
  code === undefined
    ? "the task never reported an exit code"
    : `exit ${code}${code === 127 ? " — command not found; VS Code runs hooks in the AUTOMATION profile, not your interactive shell" : ""}`;
