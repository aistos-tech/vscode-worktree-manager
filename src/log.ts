import * as vscode from "vscode";

/* The extension's only log surface. It did not have one until 0.33.0, and the absence had a cost:
   a PR row whose worktree creation threw produced NOTHING — no dialog, no output, no trace — because
   every caller launches the flow as `void createWorktree(...)` and an unhandled rejection in an
   extension host is swallowed. "Nothing happened" was the entire bug report available.

   `{ log: true }` makes it a LogOutputChannel rather than a plain one, which buys three things a
   hand-rolled channel does not: per-level filtering the user controls from *Developer: Set Log
   Level…*, timestamps VS Code writes itself, and `trace`/`debug` output that costs nothing when the
   level is above it. */
let channel: vscode.LogOutputChannel | undefined;

export const initLog = (context: vscode.ExtensionContext) => {
  channel = vscode.window.createOutputChannel("Aistos", { log: true });
  context.subscriptions.push(channel);
  return channel;
};

export const showLog = () => channel?.show(true);

export const logInfo = (message: string) => channel?.info(message);
export const logDebug = (message: string) => channel?.debug(message);

/* ⚠️ Errors are logged AND surfaced. A log nobody opens is not a report: the failure this file
   exists for was invisible precisely because the user had no reason to look anywhere. The toast
   names the operation and offers the log; the log carries the stack. */
export const logError = (operation: string, error: unknown) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  channel?.error(`${operation} failed\n${detail}`);
  void vscode.window
    .showErrorMessage(`Aistos: ${operation} failed — ${describe(error)}`, "Show Logs")
    .then((choice) => {
      if (choice === "Show Logs") showLog();
    });
};

const describe = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine || "unknown error";
};

/* The wrapper every fire-and-forget flow goes through. `void promise` is what made a rejection
   silent; `report` keeps the same non-blocking shape at the call site and cannot swallow one. */
export const report = (operation: string, promise: Promise<unknown>) => {
  void promise.catch((error: unknown) => logError(operation, error));
};
