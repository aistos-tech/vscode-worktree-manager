import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* Two windows can both pass the locked/prunable check, both run preDelete — two concurrent
   `compose down -v` on one project — and both call `git worktree remove`. Two `$(sync)` clicks run
   concurrent `bun install` in one node_modules. Nothing in VS Code serialises across windows:
   `globalState` writes are read-modify-write with no cross-window notification, so it cannot be
   used as a mutex. A file with O_EXCL can. */

const LOCK_DIR = "worktree-locks";

type LockProps = {
  primaryPath: string;
  id: string;
};

const lockPath = ({ primaryPath, id }: LockProps) =>
  join(primaryPath, ".git", LOCK_DIR, `${id}.lock`);

type LockRecord = {
  pid: number;
  at: number;
  operation: string;
};

const readLock = (path: string): LockRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Partial<LockRecord>;
    if (typeof record.pid !== "number") return undefined;
    return {
      pid: record.pid,
      at: typeof record.at === "number" ? record.at : 0,
      operation: typeof record.operation === "string" ? record.operation : "?",
    };
  } catch {
    return undefined;
  }
};

/* A crashed extension host leaves the file behind, and a lock nothing can clear is worse than no
   lock — the worktree becomes permanently undeletable from the editor with no message that
   explains why. `process.kill(pid, 0)` tests liveness without signalling. Both conditions are
   required: the PID may have been recycled, so age is the second opinion. */
const HELD_TTL_MS = 60 * 60 * 1000;

const isStale = (record: LockRecord, now: number) => {
  if (now - record.at > HELD_TTL_MS) return true;
  try {
    process.kill(record.pid, 0);
    return false;
  } catch (error) {
    /* EPERM means the process exists and belongs to someone else — alive, not stale. */
    return (error as NodeJS.ErrnoException).code !== "EPERM";
  }
};

export type LockOutcome =
  | { acquired: true; release: () => void }
  | { acquired: false; heldBy: string };

export const acquireWorktreeLock = ({
  primaryPath,
  id,
  operation,
}: LockProps & { operation: string }): LockOutcome => {
  const path = lockPath({ primaryPath, id });
  mkdirSync(join(primaryPath, ".git", LOCK_DIR), { recursive: true });

  const write = () => {
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: Date.now(), operation }), {
      flag: "wx",
    });
    return {
      acquired: true as const,
      release: () => rmSync(path, { force: true }),
    };
  };

  try {
    return write();
  } catch {
    const existing = existsSync(path) ? readLock(path) : undefined;
    if (existing && !isStale(existing, Date.now())) {
      return { acquired: false, heldBy: existing.operation };
    }
    /* Stale or unreadable: clear and retry once. A second failure means someone won the race in
       between, which is the lock working. */
    rmSync(path, { force: true });
    try {
      return write();
    } catch {
      return { acquired: false, heldBy: existing?.operation ?? "another window" };
    }
  }
};
