/* Version comparison, kept in its own module for one reason: it must import nothing from `vscode`.
   `bun test` runs outside an extension host and cannot resolve that module, so a pure function that
   lives beside a `vscode` import is a pure function nothing can test — the same constraint
   `worktree.ts` is built around. */

/* Releases are tagged `v0.40.0` and package.json carries `0.40.0`. Comparing the two directly is
   always unequal, which reports an update on every check forever. */
export const stripV = (tag: string) => tag.replace(/^v/, "");

/* Numeric per part, not lexicographic. A string compare makes `0.9.0` newer than `0.10.0`, and a
   plain `!==` offers a downgrade to anyone running a build ahead of the last release — both produce
   a prompt that no install can clear. Anything unparseable returns false: refusing to guess costs a
   missed notification once, where guessing costs a permanent one. */
export const isNewer = (candidate: string, current: string) => {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
};
