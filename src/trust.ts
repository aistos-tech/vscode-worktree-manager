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
  const answer = await vscode.window.showWarningMessage(
    known ? "This repo's worktree hook has changed. Run it?" : "Run this repo's worktree hook?",
    {
      modal: true,
      detail:
        `${command}\n\nfrom ${source}/.vscode/settings.json\n\n${consequence}\n\n` +
        "Approving trusts this repo's whole script tree at its current commit, not just the " +
        "command above. The approval is re-asked when the command, the folder it came from, or " +
        "anything under scripts/ changes.",
    },
    "Run hook",
  );
  if (answer !== "Run hook") return false;

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
