/* Status rows for the network contexts. Pure, and in its own module, because the bug this exists to
   prevent shipped once already: the "Sign in to Linear" and "Sign in to GitHub" rows were built as
   bare `{ label }` objects, so they rendered correctly, looked actionable and did nothing —
   `onDidAccept` tested for create/PR/issue/worktree items and a bare label is none of them, so every
   branch fell through silently.

   It lived in the one module the test runner cannot load (`extension.ts` imports `vscode`), which is
   why nothing caught it. Keeping the construction here means the invariant "a note with an action
   produces an item carrying that action" is checkable. */

export type NoteAction = "signInLinear" | "signInGitHub" | "retry";

export type Note = { label: string; action?: NoteAction };

export type NoteItem = {
  label: string;
  detail?: string;
  alwaysShow: true;
  noteAction?: NoteAction;
};

export const isActionableNote = (item: { noteAction?: NoteAction }) =>
  item.noteAction !== undefined;

/* A row that does something says so. Without the hint, an actionable row and a status line are
   indistinguishable, and the user has to press Enter on each to find out which is which. */
export const noteRow = (note: Note): NoteItem =>
  note.action
    ? {
        label: note.label,
        detail: "Press Enter",
        alwaysShow: true,
        noteAction: note.action,
      }
    : { label: note.label, alwaysShow: true };

export const signInNote = (provider: "linear" | "github"): Note =>
  provider === "linear"
    ? { label: "$(key) Sign in to Linear", action: "signInLinear" }
    : { label: "$(key) Sign in to GitHub", action: "signInGitHub" };

/* A failure the user can act on carries the action; one they cannot does not. A 401 is fixed by
   signing in again, so it offers that rather than making them find the palette — but "no GitHub
   remote on this repo" is not fixed by signing in, and offering it there would be a lie. */
export const errorNote = ({
  message,
  provider,
  recoverable,
}: {
  message: string;
  provider: "linear" | "github";
  recoverable: boolean;
}): Note => ({
  label: `$(warning) ${message}`,
  ...(recoverable
    ? { action: provider === "linear" ? ("signInLinear" as const) : ("signInGitHub" as const) }
    : {}),
});
