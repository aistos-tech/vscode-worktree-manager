import * as vscode from "vscode";
import { logInfo } from "./log";

/* Every long-running step in this extension is a hook run or a git call that can take minutes, and
   before 0.39.0 all of them showed nothing while they ran. Shared rather than per-flow so create,
   bootstrap and delete look the same: a flow that reports its progress and one that does not is a
   difference the user has to learn instead of a tool they can use.

   One notification per step, ending when the step ends. Deliberately not one held open across a
   whole flow: the steps fail differently, and a bar that spans several says less than a title that
   names the one running.

   Not cancellable, and that is not an oversight. Neither a `git worktree add` nor a bootstrap is
   safely interruptible — the first leaves a half-registered worktree, the second a half-built
   stack that the pre-delete hook then has to tear down. */
export const withStep = <T>(
  message: string,
  run: (progress: vscode.Progress<{ message?: string }>) => Thenable<T>,
) => {
  logInfo(`step: ${message}`);
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Aistos: ${message}`,
      cancellable: false,
    },
    (progress) => run(progress),
  );
};

/* A notification is one line and does not wrap: a long line pushes the title off the right edge and
   you lose which step is running, which is the one thing the notification is for. Trimmed from the
   FRONT because a build tool's useful half — the file, the error — is at the end of the line. */
export const tail = (line: string) => (line.length > 80 ? `…${line.slice(-79)}` : line);
