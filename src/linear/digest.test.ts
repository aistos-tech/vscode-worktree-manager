import { describe, expect, test } from "bun:test";
import { digestFor, escapeIcons } from "./digest";

const issue = (over: Partial<Parameters<typeof digestFor>[0]> = {}) =>
  digestFor({
    identifier: "A-1661",
    title: "Import mapping",
    state: { name: "In Progress", type: "started" },
    assignee: { displayName: "Thibault" },
    ...over,
  });

describe("escapeIcons", () => {
  /* The case that made this necessary: a ticket body or title containing a shell substitution.
     `$(` renders as a theme icon in label, description AND detail, so it would be swallowed. */
  test("neutralises a theme-icon sequence", () => {
    expect(escapeIcons('cd "$(bun run create-worktree)"')).not.toContain("$(");
  });

  test("keeps the surrounding text readable", () => {
    const escaped = escapeIcons('cd "$(bun run x)"');
    expect(escaped).toContain("bun run x");
    expect(escaped).toContain("cd ");
  });

  test("escapes every occurrence, not just the first", () => {
    const escaped = escapeIcons("$(a) and $(b)");
    expect(escaped.split("$​(").length - 1).toBe(2);
  });

  test("leaves text with no sequence untouched", () => {
    expect(escapeIcons("plain title")).toBe("plain title");
  });
});

describe("digestFor", () => {
  test("leads with the identifier and title", () => {
    expect(issue()[0]?.label).toContain("A-1661");
    expect(issue()[0]?.label).toContain("Import mapping");
  });

  test("shows the state name and assignee", () => {
    const row = issue()[1];
    expect(row?.label).toContain("In Progress");
    expect(row?.description).toBe("Thibault");
  });

  test("says unassigned rather than leaving it blank", () => {
    expect(issue({ assignee: null })[1]?.description).toBe("unassigned");
  });

  test("picks an icon from the state TYPE, not its name", () => {
    /* Names are per-team and arbitrary; types are Linear's own fixed vocabulary. */
    const done = issue({ state: { name: "Shipped", type: "completed" } })[1];
    expect(done?.label).toContain("$(pass-filled)");
  });

  test("falls back to a neutral icon for an unknown state type", () => {
    const odd = issue({ state: { name: "Weird", type: "brand-new" } })[1];
    expect(odd?.label).toContain("$(circle-outline)");
  });

  test("escapes a title that would otherwise render an icon", () => {
    const rows = issue({ title: "run $(bun test)" });
    expect(rows[0]?.label).not.toContain("$(bun");
  });

  test("always offers Open in Linear as the last row", () => {
    expect(issue().at(-1)?.label).toContain("Open in Linear");
  });
});
