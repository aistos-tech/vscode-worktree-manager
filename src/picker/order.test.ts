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

import { byGroupThenLocal, groupStarts, PR_GROUP_LABEL } from "./order";

const pr = (id: string, group: "review" | "mine" | "other", local = false) => ({
  id,
  group,
  local,
});

describe("byGroupThenLocal", () => {
  test("orders review, then yours, then other", () => {
    const ordered = byGroupThenLocal([pr("c", "other"), pr("a", "review"), pr("b", "mine")]);
    expect(ordered.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  /* Local-first applies WITHIN a group, never across: a checked-out "other" PR must not outrank
     one that is actually waiting on you. */
  test("does not let a local row jump its group", () => {
    const ordered = byGroupThenLocal([pr("local-other", "other", true), pr("review", "review")]);
    expect(ordered.map((row) => row.id)).toEqual(["review", "local-other"]);
  });

  test("puts local first inside a group", () => {
    const ordered = byGroupThenLocal([pr("a", "mine"), pr("b", "mine", true)]);
    expect(ordered.map((row) => row.id)).toEqual(["b", "a"]);
  });

  test("preserves incoming order for equal group and locality", () => {
    const ordered = byGroupThenLocal([pr("a", "mine"), pr("b", "mine"), pr("c", "mine")]);
    expect(ordered.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

describe("groupStarts", () => {
  test("marks the first row of each group", () => {
    const starts = groupStarts([pr("a", "review"), pr("b", "mine"), pr("c", "mine")]);
    expect([...starts.entries()]).toEqual([
      [0, "review"],
      [1, "mine"],
    ]);
  });

  test("labels every group", () => {
    expect(PR_GROUP_LABEL.review).toBe("Awaiting your review");
    expect(PR_GROUP_LABEL.mine).toBe("Yours");
    expect(PR_GROUP_LABEL.other).toBe("Other");
  });

  test("handles an empty list", () => {
    expect(groupStarts([]).size).toBe(0);
  });
});
