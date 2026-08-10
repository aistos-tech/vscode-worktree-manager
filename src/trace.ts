/* A log sink with NO `vscode` import, and that is the whole reason it exists.

   `worktree.ts` holds every git call and is deliberately vscode-free: `bun test` cannot import a
   module that imports `vscode`, and the porcelain parsing there is the code most worth proving.
   Importing the log channel into it would trade 96 runnable tests for the ability to write a log
   line. So the sink is a callback: `initLog` installs the real one at activation, and everything
   else — tests, a future CLI — gets the no-op default.

   Deliberately not an EventEmitter or a subscriber list. There is exactly one consumer, and a
   second one would be a reason to reach for the real thing rather than to generalise this. */
type Sink = (message: string) => void;

let sink: Sink = () => {};

export const setTrace = (next: Sink) => {
  sink = next;
};

export const trace = (message: string) => sink(message);
