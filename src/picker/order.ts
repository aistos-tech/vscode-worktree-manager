/* Local first. Pure, so the ordering rule is provable rather than eyeballed.

   The point of a network context is to get you INTO work, and the fastest version of that is
   switching to a worktree you already have. A list that interleaves the three you can switch to
   with the twenty you would have to create buries the cheap action inside the expensive one. */

type Ranked = {
  /* Whether a worktree already exists for this row's branch. */
  local: boolean;
};

export const byLocalFirst = <T extends Ranked>(rows: readonly T[]) =>
  /* Stable within each group: the server already ordered these — Linear by updatedAt, GitHub by
     search relevance — and re-sorting inside a group would throw that away. Array.prototype.sort is
     specified as stable, so partitioning on one boolean preserves it. */
  [...rows].sort((left, right) => Number(right.local) - Number(left.local));

/* A separator between the two groups, so "local" reads as a grouping rather than as an accident of
   ordering. Returns undefined when there is nothing to separate — a lone separator above an
   otherwise empty list is noise. */
export const localSplitIndex = <T extends Ranked>(ordered: readonly T[]) => {
  const first = ordered.findIndex((row) => !row.local);
  if (first <= 0) return undefined;
  return first === ordered.length ? undefined : first;
};

/* PR grouping, on top of the local-first split. Review first because it is the only group with an
   action attached to it; yours next because you can act on it; everything else last. */
export const PR_GROUP_ORDER = ["review", "mine", "other"] as const;

export type PrGroup = (typeof PR_GROUP_ORDER)[number];

export const PR_GROUP_LABEL: Record<PrGroup, string> = {
  review: "Awaiting your review",
  mine: "Yours",
  other: "Other",
};

export const byGroupThenLocal = <T extends { group: PrGroup; local: boolean }>(
  rows: readonly T[],
) =>
  [...rows].sort((left, right) => {
    const byGroup = PR_GROUP_ORDER.indexOf(left.group) - PR_GROUP_ORDER.indexOf(right.group);
    if (byGroup !== 0) return byGroup;
    /* Local first WITHIN a group, not across them: a checked-out "other" PR should not outrank one
       that is actually waiting on you. */
    return Number(right.local) - Number(left.local);
  });

/* Indices where a new group starts, so the caller can insert a separator ahead of each. Never
   returns 0 — a separator above the first row is a header for nothing. */
export const groupStarts = <T extends { group: PrGroup }>(ordered: readonly T[]) => {
  const starts = new Map<number, PrGroup>();
  ordered.forEach((row, index) => {
    if (index === 0 || ordered[index - 1]?.group !== row.group) {
      starts.set(index, row.group);
    }
  });
  return starts;
};
