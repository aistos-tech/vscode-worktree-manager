/* Markdown → plain text, for the modal. Pure, no vscode import.

   A VS Code modal renders `detail` as PLAIN TEXT: no markdown, no images, no links. So a ticket
   body cannot be passed through raw — `![](url)` becomes a line of punctuation, `- [ ]` reads as
   noise, and a fenced block arrives with its backticks. Flattening is not a nicety here, it is the
   difference between a readable dialog and a wall of syntax. Anything this cannot represent is
   named rather than dropped, so the reader knows something is there and can hit Open in Linear. */

/* `$(name)` renders as a theme icon in a QuickPickItem's label, description AND detail, so any
   issue-derived text that reaches a row has to be neutralised — a ticket titled `run $(bun test)`
   would otherwise be swallowed or drawn as a broken glyph. Modals do not interpret it, but rows
   still do. */
export const escapeIcons = (text: string) => text.replaceAll("$(", "$​(");

const IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const LINK = /\[([^\]]+)\]\(([^)]*)\)/g;
/* A table ROW is any line of pipe-separated cells; the alignment row under the header is the one
   made only of dashes and colons, and it carries no information once the pipes are gone. */
const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
/* `[ \\t]`, never `\\s`: `\\s` matches newlines, so the rule swallowed the blank lines on either
   side of itself and welded three paragraphs into one. */
const RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;

/* Linear pastes bare upload URLs as well as markdown images, and a raw signed URL is a line of
   opaque query string that tells the reader nothing. */
const BARE_UPLOAD = /https:\/\/uploads\.linear\.app\/\S+/g;

const flattenTables = (text: string) =>
  text
    .split("\n")
    .flatMap((line) => {
      if (TABLE_DIVIDER.test(line) && line.includes("|")) return [];
      const row = TABLE_ROW.exec(line);
      if (!row?.[1]) return [line];
      return [
        row[1]
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join("  ·  "),
      ];
    })
    .join("\n");

export const toPlainText = (markdown: string) =>
  flattenTables(markdown)
    /* Images cannot render, so they become a named placeholder rather than vanishing — a ticket
       whose content IS a screenshot would otherwise look empty. */
    .replaceAll(IMAGE, (_match, alt: string) => `[image${alt ? `: ${alt}` : ""}]`)
    /* Links keep their text and lose the URL: the URL is unclickable here and is usually longer
       than the sentence containing it. */
    .replaceAll(LINK, (_match, label: string) => label)
    .replaceAll(BARE_UPLOAD, "[attachment]")
    /* Before the bullet rewrite, so a spaced `- - -` is read as a rule rather than as a bullet. A
       horizontal rule is a real separator in a long ticket and survives as one. */
    .replace(RULE, "──────────")
    /* Checklists are decisions, and they survive as something a reader recognises. */
    .replace(/^(\s*)[-*]\s+\[ \]\s+/gm, "$1☐ ")
    .replace(/^(\s*)[-*]\s+\[[xX]\]\s+/gm, "$1☑ ")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    /* Fences lose their backticks but keep their content and indentation. */
    .replace(/^```.*$/gm, "")
    .replaceAll("`", "")
    /* Heading hashes go; the text stays as its own line, which is enough structure here. */
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    /* Strikethrough usually marks something decided against, which is worth keeping visible. */
    .replace(/~~([^~]+)~~/g, "($1 — struck)")
    /* Inline HTML: Linear allows it and a modal cannot render it. */
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    /* Bold/italic markers, without eating a lone asterisk mid-word. */
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    /* Three or more blank lines collapse: markdown authors leave a lot of air that a fixed-height
       dialog cannot afford. */
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/* Generous on purpose. The first value here was 1400, which cut ordinary tickets in half — the
   limit exists to stop a pathological body making the dialog taller than the screen, not to keep
   the preview short. A normal Linear description is well inside this; anything past it is one
   button away, and the sidebar renders the whole thing properly regardless. */
export const MODAL_BODY_LIMIT = 6000;

export const truncate = (text: string, limit = MODAL_BODY_LIMIT) => {
  if (text.length <= limit) return text;
  /* Cuts at a paragraph, then a sentence, then a word — never mid-word, because a truncated word
     reads as a typo rather than as an elision. */
  const window = text.slice(0, limit);
  const cut = Math.max(
    window.lastIndexOf("\n\n"),
    window.lastIndexOf(". "),
    window.lastIndexOf(" "),
  );
  return `${window.slice(0, cut > limit * 0.5 ? cut : limit).trimEnd()}\n\n… continued in Linear`;
};

type BodyProps = {
  identifier: string | undefined;
  title: string | undefined;
  state: string | undefined;
  assignee: string | undefined;
  description: string | undefined;
  pr: { number: number; state: string } | undefined;
  branch: string | undefined;
};

/* The modal's two halves: `message` is the bold heading, `detail` the body. Every line is optional
   because a row may have a branch and nothing else, and the dialog still has to say something
   truthful rather than render an empty shell. */
export const modalBody = ({
  identifier,
  title,
  state,
  assignee,
  description,
  pr,
  branch,
}: BodyProps) => {
  const heading = [identifier, title].filter(Boolean).join("  ") || branch || "Worktree";

  const facts = [state, assignee, pr ? `PR #${pr.number} ${pr.state.toLowerCase()}` : undefined]
    .filter(Boolean)
    .join("  ·  ");

  const body = description ? truncate(toPlainText(description)) : "";

  const detail = [
    branch,
    facts,
    body,
    !identifier && branch ? "No Linear issue on this branch." : undefined,
    identifier && !title ? "Could not read this issue from Linear." : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { message: heading, detail };
};
