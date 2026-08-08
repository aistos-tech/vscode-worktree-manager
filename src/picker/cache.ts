import type { Worktree } from "../worktree";

/* The join is DERIVED, never stored, and the cache is the only thing persisted. They live in one
   file precisely because they must not be confused: a stored join becomes a second source of truth
   that drifts the moment a PR merges, a branch is renamed or an issue moves, and then needs the
   invalidation the derived join gets for free. Keeping them here with one exported shape is what
   stops a future change quietly persisting the join. */

export type Enrichment = {
  identifier?: string;
  pullRequest?: number;
};

export type Joined = {
  branch: string;
  worktree?: Worktree;
} & Enrichment;

type JoinProps = {
  worktrees: readonly Worktree[];
  enrichment: ReadonlyMap<string, Enrichment>;
};

/* All three sources already carry the SAME string — Linear's `branchName`, a PR's `headRefName`,
   and the worktree's branch are byte-identical, because the branch name is copied from Linear
   rather than rebuilt. So there is no mapping to persist; this is a pure function of its inputs
   and cannot be stale. */
export const joinOnBranch = ({ worktrees, enrichment }: JoinProps): Joined[] =>
  worktrees.map((worktree) => ({
    branch: worktree.branch,
    worktree,
    ...(enrichment.get(worktree.branch) ?? {}),
  }));

/* Item instances are reused across a cached→fresh swap because QuickPick matches activeItems by
   object IDENTITY: swapping in fresh objects for logically-identical rows drops the highlight even
   if you restore by index. Keyed by branch, which is the join key. */
export const reuseItems = <T extends { branch: string }>({
  previous,
  next,
}: {
  previous: readonly T[];
  next: readonly T[];
}): T[] => {
  const byBranch = new Map(previous.map((item) => [item.branch, item]));
  return next.map((item) => {
    const existing = byBranch.get(item.branch);
    if (!existing) return item;
    /* Mutating the surviving instance keeps its identity while updating what it shows. */
    Object.assign(existing, item);
    return existing;
  });
};
