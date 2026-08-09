import { describe, expect, test } from "bun:test";
import { byLocalFirst, localSplitIndex } from "./order";

const row = (id: string, local: boolean) => ({ id, local });

describe("byLocalFirst", () => {
  test("puts rows with an existing worktree first", () => {
    const ordered = byLocalFirst([row("a", false), row("b", true), row("c", false)]);
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });

  /* The server already ordered these — Linear by updatedAt, GitHub by relevance — so re-sorting
     within a group would discard information the caller cannot recover. */
  test("preserves the incoming order within each group", () => {
    const ordered = byLocalFirst([
      row("a", false),
      row("b", true),
      row("c", false),
      row("d", true),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["b", "d", "a", "c"]);
  });

  test("does not mutate the input", () => {
    const input = [row("a", false), row("b", true)];
    byLocalFirst(input);
    expect(input.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  test("handles all-local and none-local without reordering", () => {
    expect(byLocalFirst([row("a", true), row("b", true)]).map((e) => e.id)).toEqual(["a", "b"]);
    expect(byLocalFirst([row("a", false), row("b", false)]).map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("handles an empty list", () => {
    expect(byLocalFirst([])).toEqual([]);
  });
});

describe("localSplitIndex", () => {
  test("points at the first non-local row", () => {
    expect(localSplitIndex([row("a", true), row("b", false)])).toBe(1);
  });

  /* A separator with nothing above it is a header for an empty group. */
  test("is undefined when nothing is local", () => {
    expect(localSplitIndex([row("a", false), row("b", false)])).toBeUndefined();
  });

  test("is undefined when everything is local", () => {
    expect(localSplitIndex([row("a", true), row("b", true)])).toBeUndefined();
  });

  test("is undefined for an empty list", () => {
    expect(localSplitIndex([])).toBeUndefined();
  });
});
