import { describe, expect, test } from "bun:test";
import { escapeIcons, modalBody, toPlainText, truncate } from "./text";

describe("escapeIcons", () => {
  test("neutralises a theme-icon sequence", () => {
    expect(escapeIcons('cd "$(bun run x)"')).not.toContain("$(");
  });

  test("keeps the surrounding text readable", () => {
    expect(escapeIcons('cd "$(bun run x)"')).toContain("bun run x");
  });

  test("escapes every occurrence", () => {
    expect(escapeIcons("$(a) and $(b)").split("$​(").length - 1).toBe(2);
  });
});

describe("toPlainText", () => {
  /* A modal renders detail as PLAIN TEXT, so anything left as syntax reads as noise. */
  test("names an image rather than dropping it", () => {
    expect(toPlainText("![dashboard](https://uploads.linear.app/x)")).toBe("[image: dashboard]");
  });

  test("names an image with no alt text", () => {
    expect(toPlainText("![](https://uploads.linear.app/x)")).toBe("[image]");
  });

  test("keeps link text and discards the url", () => {
    expect(toPlainText("see [the spec](https://example.com/very/long)")).toBe("see the spec");
  });

  test("renders checklists as boxes", () => {
    expect(toPlainText("- [ ] mapping\n- [x] rule")).toBe("☐ mapping\n☑ rule");
  });

  test("renders plain bullets", () => {
    expect(toPlainText("- one\n- two")).toBe("• one\n• two");
  });

  /* Mid-body, where nesting actually occurs — the trailing trim legitimately removes indentation
     at the very start of a body, which is leading whitespace rather than structure. */
  test("preserves checklist indentation", () => {
    expect(toPlainText("- [ ] outer\n  - [ ] nested")).toBe("☐ outer\n  ☐ nested");
  });

  test("strips fences but keeps the code", () => {
    expect(toPlainText("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  test("strips heading hashes and keeps the text", () => {
    expect(toPlainText("## Context\nbody")).toBe("Context\nbody");
  });

  test("strips bold and italic markers", () => {
    expect(toPlainText("**bold** and _italic_")).toBe("bold and italic");
  });

  /* A lone asterisk or underscore mid-word is ordinary prose, not emphasis. */
  test("leaves snake_case identifiers alone", () => {
    expect(toPlainText("call read_slot now")).toBe("call read_slot now");
  });

  test("collapses runs of blank lines", () => {
    expect(toPlainText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  test("handles French accents untouched", () => {
    expect(toPlainText("les colonnes déjà normalisées")).toBe("les colonnes déjà normalisées");
  });

  test("returns empty for empty input", () => {
    expect(toPlainText("")).toBe("");
  });
});

describe("truncate", () => {
  test("leaves short text alone", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  /* Never mid-word: a cut word reads as a typo rather than as an elision. */
  test("cuts at a boundary and says it continued", () => {
    const cut = truncate(`${"word ".repeat(50)}end`, 60);
    expect(cut).toContain("… continued in Linear");
    expect(cut).not.toMatch(/wor\n/);
  });

  test("prefers a paragraph break when one is in range", () => {
    const text = `${"a".repeat(40)}\n\n${"b".repeat(200)}`;
    expect(truncate(text, 100).startsWith("a".repeat(40))).toBe(true);
  });
});

describe("modalBody", () => {
  const base = {
    identifier: "A-1661",
    title: "Import mapping",
    state: "In Progress",
    assignee: "Thibault",
    description: "Le mapping doit tolérer une colonne absente.",
    pr: { number: 421, state: "OPEN" },
    branch: "thblt-thlgn/acme-42-import",
  };

  test("heads with the identifier and title", () => {
    expect(modalBody(base).message).toBe("ACME-42  Import mapping");
  });

  test("puts state, assignee and PR on one line", () => {
    expect(modalBody(base).detail).toContain("In Progress  ·  Thibault  ·  PR #421 open");
  });

  test("includes the flattened description", () => {
    expect(modalBody(base).detail).toContain("Le mapping doit tolérer");
  });

  /* The everyday case: the primary worktree has no issue and the dialog must still say something
     true rather than render an empty shell. */
  test("says so when the branch carries no issue", () => {
    const body = modalBody({
      ...base,
      identifier: undefined,
      title: undefined,
      state: undefined,
      assignee: undefined,
      description: undefined,
      pr: undefined,
    });
    expect(body.message).toBe("thblt-thlgn/acme-42-import");
    expect(body.detail).toContain("No Linear issue on this branch.");
  });

  test("says so when the issue could not be read", () => {
    const body = modalBody({ ...base, title: undefined, description: undefined });
    expect(body.detail).toContain("Could not read this issue from Linear.");
  });

  test("omits the PR line when there is none", () => {
    expect(modalBody({ ...base, pr: undefined }).detail).not.toContain("PR #");
  });

  test("never returns an empty heading", () => {
    const body = modalBody({
      identifier: undefined,
      title: undefined,
      state: undefined,
      assignee: undefined,
      description: undefined,
      pr: undefined,
      branch: undefined,
    });
    expect(body.message).toBe("Worktree");
  });
});
