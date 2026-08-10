import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const APPROVAL_PREFIX = "hookApproval:";

/* One key per approved repo, never a single map of all approvals. `globalState` writes here are
   read-modify-write over whole objects, so a shared map lets a stale window clobber an approval.
   Today that costs a pin colour; with trust in the same structure it would silently restore a
   revoked one. */
const keyFor = (primaryPath: string) => `${APPROVAL_PREFIX}${primaryPath}`;

type Approval = {
  origin: string;
  command: string;
  source: string;
  payload: string;
};

const gitOut = async (args: string[], cwd: string) => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  } catch {
    return "";
  }
};

/* Hashes the TRACKED TREE of the things a hook actually executes, not the commit. HEAD moves on
   every commit, pull and rebase — several times a day — so keying on it would re-prompt
   continuously on the two most destructive paths and train click-through. A tree digest changes
   only when the hook's own inputs change. */
const payloadDigest = async (primaryPath: string) => {
  const tree = await gitOut(
    ["ls-tree", "HEAD", "--", "scripts", ".vscode/settings.json"],
    primaryPath,
  );
  return createHash("sha256").update(tree).digest("hex").slice(0, 16);
};

type FingerprintProps = {
  primaryPath: string;
  command: string;
  source: string;
};

/* Three things, because the two candidate mechanisms cover disjoint halves and dropping either
   leaves its half open. The COMMAND STRING is what a hostile branch controls — it is resolved from
   the focused worktree's own tracked settings.json, so `gh pr checkout` can change it without
   touching the path or the origin. The PAYLOAD is what the command runs, which command-hashing
   alone misses: a branch can rewrite scripts/worktree-hook.ts and leave the settings byte-identical.
   The SOURCE is which folder the command came from. */
const fingerprint = async ({
  primaryPath,
  command,
  source,
}: FingerprintProps): Promise<Approval> => ({
  origin: await gitOut(["config", "--get", "remote.origin.url"], primaryPath),
  command,
  source,
  payload: await payloadDigest(primaryPath),
});

const matches = (stored: Approval | undefined, current: Approval) =>
  stored !== undefined &&
  stored.origin === current.origin &&
  stored.command === current.command &&
  stored.source === current.source &&
  stored.payload === current.payload;

type EnsureApprovedProps = {
  context: vscode.ExtensionContext;
  primaryPath: string;
  command: string;
  source: string;
  consequence: string;
};

/* Returns false on decline. Callers on the delete path MUST treat that as a refusal to delete, not
   as "no hook" — the natural implementation reuses the empty-command early return for both, and
   then clicking "No" at this prompt lets the worktree be removed with its stack still running. */
export const ensureApproved = async ({
  context,
  primaryPath,
  command,
  source,
  consequence,
}: EnsureApprovedProps) => {
  const current = await fingerprint({ primaryPath, command, source });
  const stored = context.globalState.get<Approval>(keyFor(primaryPath));
  if (matches(stored, current)) return true;

  const known = stored !== undefined;
  /* A QuickPick STEP, not a modal. This sits in the middle of a sequence of quick picks and input
     boxes — branch, source, destination — and a modal broke that rhythm: it takes over the window,
     centres itself, renders its detail as a wall of grey text, and has to be dismissed with the
     mouse or a different key than every step around it.

     The rows carry the decision, the detail carries the command, and everything else moved to the
     README. What was cut is not lost: the paragraph explaining that approval covers the whole
     script tree is read once, not re-read every time the tree changes and this re-asks. Keeping it
     here made the dialog long enough that nobody read any of it, which is worse than short.

     ⚠️ Still a real gate, and `ignoreFocusOut` is why. A quick pick dismissed by a stray click
     would return undefined and read as a decline — harmless here, but on the DELETE path a decline
     aborts the deletion, and a hook prompt that vanishes when you alt-tab would look like a bug in
     delete rather than a refusal. */
  const picked = await vscode.window.showQuickPick(
    [
      { label: "$(play) Run the hook", detail: consequence, approve: true },
      { label: "$(circle-slash) Skip it", approve: false },
    ],
    {
      title: known ? "This repo's worktree hook has changed" : "Run this repo's worktree hook?",
      placeHolder: `${command}  —  from ${source}/.vscode/settings.json`,
      ignoreFocusOut: true,
    },
  );
  if (!picked?.approve) return false;

  await context.globalState.update(keyFor(primaryPath), current);
  return true;
};

export const listApprovals = (context: vscode.ExtensionContext) =>
  context.globalState
    .keys()
    .filter((key) => key.startsWith(APPROVAL_PREFIX))
    .map((key) => ({
      key,
      path: key.slice(APPROVAL_PREFIX.length),
      approval: context.globalState.get<Approval>(key),
    }));

export const forgetApproval = (context: vscode.ExtensionContext, primaryPath: string) =>
  context.globalState.update(keyFor(primaryPath), undefined);
