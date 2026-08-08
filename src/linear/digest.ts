/* Pure: issue → rows. No vscode import, so it is unit-testable, and no markdown parser, because
   this renders SCALAR fields only.

   The popup deliberately shows the header of a ticket rather than its body. `QuickPickItem` carries
   no markdown and `detail` does not wrap — a long line truncates with an ellipsis — so a body
   digest would be prose that can be silently cut mid-sentence in a surface sitting one keystroke
   from a delete button. Five scalar fields cannot mislead that way, and `Open in Linear` is one row
   away for everything else. */

export type DigestRow = {
  label: string;
  description?: string;
  detail?: string;
};

export type DigestIssue = {
  identifier: string;
  title: string;
  state: { name: string; type: string };
  assignee?: { displayName: string } | null;
};

/* `$(name)` renders as a theme icon in label, description AND detail. A ticket title containing
   `$(` — and `cd "$(bun run …)"` is exactly the sort of thing that appears in one — would be
   swallowed or drawn as a broken glyph. Everything issue-derived goes through this; only the
   digest's own markers are emitted raw. */
export const escapeIcons = (text: string) => text.replaceAll("$(", "$​(");

const ICON_FOR_TYPE: Record<string, string> = {
  triage: "$(inbox)",
  backlog: "$(circle-outline)",
  unstarted: "$(circle-outline)",
  started: "$(circle-filled)",
  completed: "$(pass-filled)",
  canceled: "$(error)",
};

export const digestFor = (issue: DigestIssue): DigestRow[] => [
  {
    label: `${escapeIcons(issue.identifier)}  ${escapeIcons(issue.title)}`,
  },
  {
    label: `${ICON_FOR_TYPE[issue.state.type] ?? "$(circle-outline)"} ${escapeIcons(issue.state.name)}`,
    description: issue.assignee?.displayName
      ? escapeIcons(issue.assignee.displayName)
      : "unassigned",
  },
  { label: "$(link-external) Open in Linear" },
];

export const OPEN_IN_LINEAR = "$(link-external) Open in Linear";
