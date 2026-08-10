import { describe, expect, test } from "bun:test";
import { escapeIcons } from "./text";

describe("escapeIcons", () => {
  /* The case that made this necessary: a shell substitution in a ticket title. `$(` renders as a
     theme icon in a row's label, description and detail alike. */
  test("neutralises a theme-icon sequence", () => {
    expect(escapeIcons('cd "$(bun run create-worktree)"')).not.toContain("$(");
  });

  test("keeps the surrounding text readable", () => {
    const escaped = escapeIcons('cd "$(bun run x)"');
    expect(escaped).toContain("bun run x");
    expect(escaped).toContain("cd ");
  });

  test("escapes every occurrence, not just the first", () => {
    expect(escapeIcons("$(a) and $(b)").split("$​(").length - 1).toBe(2);
  });

  test("leaves text with no sequence untouched", () => {
    expect(escapeIcons("plain title")).toBe("plain title");
  });
});
