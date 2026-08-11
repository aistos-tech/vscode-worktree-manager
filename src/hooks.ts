import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { trace } from "./trace";

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
  /* Called with each complete line the hook prints. The create flow feeds it to the progress
     notification, so the last thing the hook said is visible without opening anything. */
  onLine?: (line: string) => void;
};

let nonceCounter = 0;

/* Still a `vscode.Task` — the task panel, the task list and re-running from it are all worth
   keeping. What changed in 0.39.0 is WHO owns the process.
//
   It used to be a `ShellExecution`, which VS Code runs in a terminal it owns. That has one
   consequence that turned out to matter more than everything it bought: an extension CANNOT read
   the output of a terminal it did not create. The Pseudoterminal API is explicit about it. So the
   hook's output existed only on screen, in a panel opened with `focus: false` — which is why a
   create looked frozen for minutes and the log channel could report the exit code and nothing else.

   A `CustomExecution` hands back a Pseudoterminal WE implement, so we spawn the process, and its
   stdout is ours: it goes to the terminal (unchanged on screen), to the log channel (a transcript
   that outlives the panel), and to `onLine` (the live line in the progress notification).

   Reading tasks.json was rejected separately and still is: `${input:}` cannot be filled
   programmatically, so the clicked row's path could never reach the task. */
export const runHook = ({ command, cwd, env, name, onLine }: RunHookProps) => {
  /* An empty command is "this repo has no hook", and resolves 0 so other repos are wholly
     unaffected. A DECLINED hook is not this case and must not reach here — see trust.ts. */
  if (!command) return Promise.resolve<number>(0);

  nonceCounter += 1;
  const nonce = `${Date.now()}-${nonceCounter}`;

  return new Promise<number | undefined>((resolve) => {
    let settled = false;
    const finish = (code: number | undefined) => {
      if (settled) return;
      settled = true;
      /* Logged at the single point every path converges on, including the `undefined` one. A hook
         that never reported an exit code is the case worth seeing: it is treated as failure on
         purpose, and from the outside it is indistinguishable from a hook that genuinely failed. */
      trace(`hook "${name}" finished — exit=${code ?? "<none reported>"}: ${command}`);
      resolve(code);
    };

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();
    let child: ReturnType<typeof spawn> | undefined;

    /* Partial lines are buffered rather than reported, so `onLine` never receives half a word and
       the notification never flickers mid-token. Whatever is left when the stream ends is flushed
       by `close`, because a hook whose last line has no trailing newline still said something. */
    let pending = "";
    const consume = (chunk: string) => {
      /* The terminal wants CRLF. A raw \n moves down a row without returning to column 0, which
         renders the whole transcript as a diagonal staircase. */
      writeEmitter.fire(chunk.replace(/\r?\n/g, "\r\n"));
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        trace(`hook "${name}": ${text}`);
        onLine?.(text);
      }
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,

      /* `open` is where the work starts, NOT the CustomExecution callback: the callback runs when
         the task is created, and writing before the terminal is open loses the output. */
      open: () => {
        writeEmitter.fire(`\x1b[2m${command}\x1b[0m\r\n\r\n`);
        /* A login shell (`-lc`), not a bare `-c`. VS Code's automation profile does not source a
           profile, which is the documented cause of `bun: command not found` (exit 127) — bun
           arrives via mise, and mise is set up in the shell profile. This is the one behaviour
           change in the port, and it fixes a failure the README currently documents as expected. */
        const shell = process.env.SHELL ?? "/bin/sh";
        child = spawn(shell, ["-lc", command], {
          cwd,
          /* ⚠️ Still INHERITS the parent environment. Now that the extension spawns the process it
             could subtract — `ShellExecutionOptions.env` could only merge — but removing variables
             is a security change with its own blast radius (a hook that legitimately needs
             GITHUB_TOKEN would break silently), so it stays a separate decision. What this port
             buys is that the decision is now possible at all. */
          env: { ...process.env, ...env },
        });

        child.stdout?.on("data", (data: Buffer) => consume(data.toString()));
        child.stderr?.on("data", (data: Buffer) => consume(data.toString()));

        child.on("error", (error) => {
          const text = error instanceof Error ? error.message : String(error);
          writeEmitter.fire(`\r\n\x1b[31m${text}\x1b[0m\r\n`);
          trace(`hook "${name}" could not start: ${text}`);
          closeEmitter.fire(1);
          finish(undefined);
        });

        child.on("close", (code) => {
          if (pending.trim()) {
            trace(`hook "${name}": ${pending.trim()}`);
            onLine?.(pending.trim());
          }
          /* A signal kill reports code null. Treated as failure, like every other non-zero path —
             inverting this makes preDelete silently succeed and leak the stack, which is precisely
             the bug the hook exists to prevent. */
          const exit = code ?? undefined;
          writeEmitter.fire(`\r\n\x1b[2mexit ${exit ?? "signal"}\x1b[0m\r\n`);
          closeEmitter.fire(exit ?? 1);
          finish(exit);
        });
      },

      /* Fired when the user closes the terminal. The child is killed rather than orphaned — a
         bootstrap left running against a worktree nobody is watching is worse than a failed one,
         because the pre-delete hook would later find containers it has no record of. */
      close: () => {
        child?.kill();
        finish(undefined);
      },
    };

    const task = new vscode.Task(
      /* The nonce rides in the TaskDefinition rather than the task name, where it would be
         user-visible noise in the panel. */
      { type: HOOK_TASK_TYPE, nonce },
      vscode.TaskScope.Workspace,
      name,
      /* The task SOURCE, which is the group heading in the task panel and the terminal picker. */
      "aistos",
      new vscode.CustomExecution(async () => pty),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      focus: false,
    };

    vscode.tasks.executeTask(task).then(undefined, (error: unknown) => {
      vscode.window.showErrorMessage(
        `Aistos: could not start the hook — ${error instanceof Error ? error.message : String(error)}`,
      );
      finish(undefined);
    });
  });
};

export const describeExit = (code: number | undefined) =>
  code === undefined
    ? "the task never reported an exit code"
    : `exit ${code}${code === 127 ? " — command not found; check that the hook's tools are on the PATH your login shell sets up" : ""}`;
