import { describe, expect, test } from "bun:test";
import { errorNote, isActionableNote, noteRow, signInNote } from "./notes";

/* The regression. These rows shipped as bare labels: they rendered, looked clickable, and did
   nothing, because the accept handler recognised only worktree/issue/PR/create items. */
describe("noteRow", () => {
  test("carries the action through, so the accept handler can find it", () => {
    expect(noteRow({ label: "x", action: "signInLinear" }).noteAction).toBe("signInLinear");
  });

  test("marks an actionable row as actionable", () => {
    expect(isActionableNote(noteRow({ label: "x", action: "signInGitHub" }))).toBe(true);
  });

  test("hints that the row does something", () => {
    expect(noteRow({ label: "x", action: "retry" }).detail).toBe("Press Enter");
  });

  test("leaves a plain status line inert and unhinted", () => {
    const row = noteRow({ label: "$(inbox) Nothing assigned to you" });
    expect(isActionableNote(row)).toBe(false);
    expect(row.detail).toBeUndefined();
  });

  test("always shows, so a filtered list cannot hide the way out of an empty state", () => {
    expect(noteRow({ label: "x" }).alwaysShow).toBe(true);
    expect(noteRow({ label: "x", action: "retry" }).alwaysShow).toBe(true);
  });
});

describe("signInNote", () => {
  test("routes each provider to its own action", () => {
    expect(signInNote("linear").action).toBe("signInLinear");
    expect(signInNote("github").action).toBe("signInGitHub");
  });

  test("is always actionable — a sign-in prompt that does nothing is the original bug", () => {
    expect(noteRow(signInNote("linear")).noteAction).toBeDefined();
    expect(noteRow(signInNote("github")).noteAction).toBeDefined();
  });
});

describe("errorNote", () => {
  test("offers sign-in for a failure that signing in would fix", () => {
    const note = errorNote({ message: "401", provider: "linear", recoverable: true });
    expect(note.action).toBe("signInLinear");
  });

  /* Offering sign-in for something sign-in cannot fix is worse than offering nothing: it sends the
     user through an auth flow and leaves them exactly where they were. */
  test("offers nothing for a failure signing in would not fix", () => {
    const note = errorNote({
      message: "No GitHub remote on this repo",
      provider: "github",
      recoverable: false,
    });
    expect(note.action).toBeUndefined();
    expect(isActionableNote(noteRow(note))).toBe(false);
  });

  test("keeps the reason visible in the label", () => {
    expect(
      errorNote({ message: "rate limited", provider: "linear", recoverable: true }).label,
    ).toContain("rate limited");
  });
});
