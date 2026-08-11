import { describe, expect, test } from "bun:test";
import type { Worktree } from "../worktree";
import { joinOnBranch, reuseItems } from "./cache";

const worktree = (branch: string): Worktree => ({
  id: `id-${branch}`,
  path: `/w/${branch}`,
  branch,
  isMain: false,
  createdAt: 0,
  locked: false,
  lockReason: undefined,
  prunable: false,
});

describe("joinOnBranch", () => {
  test("attaches enrichment to the matching branch", () => {
    const joined = joinOnBranch({
      worktrees: [worktree("acme-42"), worktree("staging")],
      enrichment: new Map([["acme-42", { identifier: "ACME-42", pullRequest: 404 }]]),
    });
    expect(joined[0]?.identifier).toBe("ACME-42");
    expect(joined[0]?.pullRequest).toBe(404);
    expect(joined[1]?.identifier).toBeUndefined();
  });

  test("leaves a worktree with no enrichment intact rather than dropping it", () => {
    const joined = joinOnBranch({
      worktrees: [worktree("staging")],
      enrichment: new Map(),
    });
    expect(joined).toHaveLength(1);
    expect(joined[0]?.branch).toBe("staging");
  });

  test("ignores enrichment for a branch with no worktree", () => {
    const joined = joinOnBranch({
      worktrees: [worktree("acme-42")],
      enrichment: new Map([["gone", { identifier: "ACME-999" }]]),
    });
    expect(joined).toHaveLength(1);
  });
});

describe("reuseItems", () => {
  /* The property D3 depends on: QuickPick matches activeItems by object identity, so a fresh
     object with an identical label silently drops the highlight on every refresh. */
  test("keeps the same instance for a branch that survived", () => {
    const previous = [{ branch: "acme-42", label: "old" }];
    const next = [{ branch: "acme-42", label: "new" }];
    const result = reuseItems({ previous, next });
    expect(result[0]).toBe(previous[0]);
  });

  test("updates what the surviving instance shows", () => {
    const previous = [{ branch: "acme-42", label: "old" }];
    const result = reuseItems({ previous, next: [{ branch: "acme-42", label: "new" }] });
    expect(result[0]?.label).toBe("new");
  });

  test("uses the fresh instance for a branch that is new", () => {
    const next = [{ branch: "brand-new", label: "x" }];
    expect(reuseItems({ previous: [], next })[0]).toBe(next[0]);
  });

  test("drops a branch that no longer exists", () => {
    const result = reuseItems({
      previous: [{ branch: "gone", label: "x" }],
      next: [{ branch: "kept", label: "y" }],
    });
    expect(result.map((item) => item.branch)).toEqual(["kept"]);
  });
});
