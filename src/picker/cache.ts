import type * as vscode from "vscode";
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

/* Stale-while-revalidate for the list contexts. Holds only what a ROW needs — identifier, title,
   state name, branch — never issue bodies or comments. That boundary is deliberate: globalState is
   plaintext in state.vscdb and is shared across remote hosts at the same repo path, and ticket
   bodies here carry personal data. A row's title is already visible in the picker; a
   description is a different exposure. */

const CACHE_KEY = "picker.listCache";

export type CachedRow = {
  identifier: string;
  title: string;
  state: string;
  branch: string;
};

type Cached = { at: number; rows: CachedRow[] };

type Store = Record<string, Cached>;

export const readCache = ({ context, key }: { context: vscode.ExtensionContext; key: string }) =>
  context.globalState.get<Store>(CACHE_KEY, {})[key];

export const writeCache = async ({
  context,
  key,
  rows,
}: {
  context: vscode.ExtensionContext;
  key: string;
  rows: CachedRow[];
}) => {
  const store = { ...context.globalState.get<Store>(CACHE_KEY, {}) };
  store[key] = { at: Date.now(), rows };
  await context.globalState.update(CACHE_KEY, store);
};

/* The PR cache is separate from the row cache because its shape is different, but it obeys the
   same rules: only what a row needs, cleared on sign-out with everything else. Without it the PR
   context paid a cold ~500 ms fetch on every visit, which is the exact latency the whole
   cached-first-paint design exists to avoid. */
const PR_CACHE_KEY = "picker.prCache";

type PrStore = Record<string, { at: number; rows: unknown[] }>;

export const readPrCache = <T>({
  context,
  key,
}: {
  context: vscode.ExtensionContext;
  key: string;
}) => {
  const entry = context.globalState.get<PrStore>(PR_CACHE_KEY, {})[key];
  return entry ? { at: entry.at, rows: entry.rows as T[] } : undefined;
};

export const writePrCache = async <T>({
  context,
  key,
  rows,
}: {
  context: vscode.ExtensionContext;
  key: string;
  rows: readonly T[];
}) => {
  const store = { ...context.globalState.get<PrStore>(PR_CACHE_KEY, {}) };
  store[key] = { at: Date.now(), rows: [...rows] };
  await context.globalState.update(PR_CACHE_KEY, store);
};

/* Cleared on sign-out in the same act as the credential — see linear/auth.ts. */
export const clearCache = async (context: vscode.ExtensionContext) => {
  await context.globalState.update(CACHE_KEY, undefined);
  await context.globalState.update(PR_CACHE_KEY, undefined);
};

/* Renders "as of 4 minutes ago" rather than letting `busy` stand in for freshness. `busy` conflates
   "loading" with "unverified", so a warm cache whose refetch failed would otherwise read as fresh. */
export const describeAge = (at: number, now: number) => {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};
