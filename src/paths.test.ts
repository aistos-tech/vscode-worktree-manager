import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome, toAbsolutePath } from "./paths";

const HOME = homedir();

describe("expandHome", () => {
  test("expands a leading ~/", () => {
    expect(expandHome("~/workspace/worktrees")).toBe(join(HOME, "workspace/worktrees"));
  });

  test("expands a bare ~", () => {
    expect(expandHome("~")).toBe(HOME);
  });

  test("trims, because a settings value pasted with a space is still a path", () => {
    expect(expandHome("  ~/workspace  ")).toBe(join(HOME, "workspace"));
  });

  /* `~foo` is another user's home in shell convention. Node cannot resolve it and guessing would
     silently point the worktree somewhere nobody asked for, so it is left alone. */
  test("leaves ~user alone", () => {
    expect(expandHome("~someone/workspace")).toBe("~someone/workspace");
  });

  /* A tilde is a legal filename character. Replacing one that is not in the leading position would
     corrupt a real path. */
  test("leaves an interior tilde alone", () => {
    expect(expandHome("/tmp/a~b/c")).toBe("/tmp/a~b/c");
    expect(expandHome("/tmp/~/c")).toBe("/tmp/~/c");
  });

  test("leaves an ordinary absolute path alone", () => {
    expect(expandHome("/Users/x/workspace")).toBe("/Users/x/workspace");
  });
});

describe("toAbsolutePath", () => {
  /* The regression. `isAbsolute("~/workspace/worktrees")` is false, so resolving before expanding
     produced `<cwd>/~/workspace/worktrees` — and the extension host's cwd is `/`, which is how
     `mkdirSync('/~/workspace/worktrees')` came to fail with ENOENT. */
  test("expands before deciding whether the path is absolute", () => {
    const result = toAbsolutePath("~/workspace/worktrees");
    expect(result).toBe(join(HOME, "workspace/worktrees"));
    expect(result.startsWith("/~")).toBe(false);
  });

  test("passes an absolute path through unchanged", () => {
    expect(toAbsolutePath("/tmp/worktrees")).toBe("/tmp/worktrees");
  });

  test("resolves a relative path against the process cwd", () => {
    expect(toAbsolutePath("worktrees")).toBe(join(process.cwd(), "worktrees"));
  });
});
