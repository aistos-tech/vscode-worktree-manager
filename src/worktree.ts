import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const MAIN_WORKTREE_ID = "__main__";

export type Worktree = {
  id: string;
  path: string;
  branch: string;
  isMain: boolean;
  createdAt: number;
  locked: boolean;
  lockReason: string | undefined;
  prunable: boolean;
};

/* WHY: birthtime is unavailable on some filesystems, where Node reports 0 or the ctime — falling
   back keeps the tiebreak meaningful instead of collapsing every worktree onto the epoch. */
const birthOf = (adminDir: string) => {
  if (!existsSync(adminDir)) return 0;
  const stats = statSync(adminDir);
  return stats.birthtimeMs || stats.ctimeMs;
};

/* WHY: the git admin dir is created with the worktree and survives `git worktree move`, so it
   carries both the only rename-stable identifier (its name) and the only record of when the
   worktree was created (its birth time). A `.git` directory, rather than a file, is the primary
   worktree — its admin dir is the repo itself, born when the clone was. */
export const resolveIdentity = (worktreePath: string) => {
  const gitPath = join(worktreePath, ".git");
  if (!existsSync(gitPath)) return { id: MAIN_WORKTREE_ID, createdAt: 0 };
  if (statSync(gitPath).isDirectory()) {
    return { id: MAIN_WORKTREE_ID, createdAt: birthOf(gitPath) };
  }

  const gitdir = readFileSync(gitPath, "utf8")
    .trim()
    .replace(/^gitdir:\s*/, "");
  return { id: basename(gitdir), createdAt: birthOf(gitdir) };
};

export const stderrOf = (error: unknown) => {
  if (error instanceof Error && "stderr" in error) return String(error.stderr).trim();
  return error instanceof Error ? error.message : String(error);
};

/* WHY: `locked` has two porcelain forms — bare, from a plain `git worktree lock`, and
   `locked <reason>` when one was given. Both reproduced on git 2.50.1 in `--porcelain` and `-z`
   alike. Copying this file's `startsWith("branch ")` idiom as `startsWith("locked ")` misses the
   bare form, which is exactly what the common case produces, and the delete guard then silently
   fails to fire on the worktrees it exists to protect. `prunable` is only ever emitted with a
   reason, so it has no bare form — matching both anyway costs nothing and removes the need to
   remember which is which. */
export const hasAttribute = (fields: string[], name: string) =>
  fields.some((field) => field === name || field.startsWith(`${name} `));

export const attributeReason = (fields: string[], name: string) => {
  const reason = fields
    .find((field) => field.startsWith(`${name} `))
    ?.slice(name.length + 1)
    .trim();
  return reason || undefined;
};

export const parseWorktree = (fields: string[]) => {
  const present = fields.filter(Boolean);
  const worktreePath = present
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length);
  if (!worktreePath) return undefined;

  const branchRef = present.find((field) => field.startsWith("branch "))?.slice("branch ".length);
  const { id, createdAt } = resolveIdentity(worktreePath);

  return {
    id,
    path: worktreePath,
    branch: branchRef?.replace("refs/heads/", "") ?? "detached",
    isMain: id === MAIN_WORKTREE_ID,
    createdAt,
    locked: hasAttribute(present, "locked"),
    lockReason: attributeReason(present, "locked"),
    prunable: hasAttribute(present, "prunable"),
  };
};

/* WHY: `worktree list -z` needs git ≥ 2.36 and hard-errors (exit 129) on older git — Ubuntu
   22.04 ships 2.34, so a Remote-SSH host is a realistic case. Fall back to the newline format,
   but only for that specific rejection: any other git failure must still propagate. */
const readWorktreeRecords = async (cwd: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd,
    });
    return stdout.split("\0\0").map((record) => record.split("\0"));
  } catch (error) {
    if (!/unknown (switch|option)/i.test(stderrOf(error))) throw error;
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
    return stdout.split("\n\n").map((record) => record.split("\n"));
  }
};

export const listWorktrees = async (cwd: string) => {
  const records = await readWorktreeRecords(cwd);
  return records.map(parseWorktree).filter((worktree) => worktree !== undefined);
};

export const isNotARepo = (error: unknown) => /not a git repository/i.test(stderrOf(error));

export const moveWorktree = ({ from, to, gitCwd }: { from: string; to: string; gitCwd: string }) =>
  execFileAsync("git", ["worktree", "move", from, to], { cwd: gitCwd });

export const pruneWorktrees = (gitCwd: string) =>
  execFileAsync("git", ["worktree", "prune"], { cwd: gitCwd });

export const removeWorktreeAt = ({
  path,
  gitCwd,
  force,
}: {
  path: string;
  gitCwd: string;
  force: boolean;
}) =>
  execFileAsync("git", ["worktree", "remove", ...(force ? ["--force"] : []), path], {
    cwd: gitCwd,
  });

export const describeDirt = async (worktreePath: string) => {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd: worktreePath,
  });
  const lines = stdout.split("\n").filter(Boolean);
  const shown = lines.slice(0, 10).join("\n");
  return lines.length > 10 ? `${shown}\n… and ${lines.length - 10} more` : shown;
};

export const branchExistsAnywhere = async (branch: string, gitCwd: string) => {
  const verify = async (ref: string) => {
    try {
      await execFileAsync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: gitCwd });
      return true;
    } catch {
      return false;
    }
  };
  if (await verify(`refs/heads/${branch}`)) return "local" as const;
  if (await verify(`refs/remotes/origin/${branch}`)) return "remote" as const;
  return undefined;
};

export const listBranches = async (gitCwd: string) => {
  const { stdout } = await execFileAsync(
    "git",
    ["for-each-ref", "--sort=-committerdate", "refs/heads", "--format=%(refname:short)"],
    { cwd: gitCwd },
  );
  return stdout.split("\n").filter(Boolean);
};

export const currentBranch = async (gitCwd: string) => {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: gitCwd });
  return stdout.trim();
};

/* The branch is the commit-ish and is NEVER omitted. `git worktree add <dest>` with no reference
   DWIMs a NEW branch from the dest basename — reproduced on git 2.50.1: with
   `thblt-thlgn/acme-42-import` existing and dest `worktrees/acme-42-import`, git
   printed "Preparing worktree (new branch 'acme-42-import')" and left the intended branch
   untouched. Namespaced branches are the normal case here, not an edge. */
export const addWorktree = ({
  dest,
  branch,
  source,
  gitCwd,
}: {
  dest: string;
  branch: string;
  source: string | undefined;
  gitCwd: string;
}) =>
  execFileAsync(
    "git",
    source === undefined
      ? ["worktree", "add", dest, branch]
      : ["worktree", "add", "-b", branch, dest, source],
    { cwd: gitCwd },
  );

export const originUrl = async (gitCwd: string) => {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "remote.origin.url"], {
      cwd: gitCwd,
    });
    return stdout.trim();
  } catch {
    return "";
  }
};
