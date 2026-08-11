import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { logDebug, logInfo } from "./log";
import { isNewer, stripV } from "./version";

/* Self-update against GitHub releases.
 *
 * There is no marketplace listing, so VS Code will never update this extension and never tell you
 * that it is old. That gap is not cosmetic: a repo binds `preDelete` in its tracked
 * `.vscode/settings.json`, so everyone on the repo gets the setting while only people running a
 * current build get the hook — an old install orphans a stack per delete and says nothing. The
 * version in `~/.vscode/extensions/<id>-<version>/` is the only staleness signal that exists, and
 * nothing reads it back to you. This does.
 *
 * UNAUTHENTICATED on purpose. The repo is public, so the releases API needs no token and no
 * `vscode.authentication` session — which means the check runs on a machine that has never signed
 * in to anything, and a first install is a curl rather than an OAuth dance. The rate limit is 60
 * requests per hour per IP against one call per day. */

const REPO = "aistos-tech/vscode-worktree-manager";
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET = "aistos.vsix";
const CHECKED_KEY = "update.lastCheckedAt";
const DAY_MS = 24 * 60 * 60 * 1000;

type Release = { tag: string; version: string; asset: string; digest?: string };

const fetchLatest = async (): Promise<Release | undefined> => {
  const response = await fetch(LATEST, {
    headers: { accept: "application/vnd.github+json" },
  });
  logDebug(`update: GET releases/latest -> ${response.status}`);
  if (!response.ok) return undefined;

  const body = (await response.json()) as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown; digest?: unknown }[];
  };
  if (typeof body.tag_name !== "string") return undefined;

  const asset = body.assets?.find((candidate) => candidate.name === ASSET);
  if (typeof asset?.browser_download_url !== "string") return undefined;

  return {
    tag: body.tag_name,
    version: stripV(body.tag_name),
    asset: asset.browser_download_url,
    digest: typeof asset.digest === "string" ? asset.digest : undefined,
  };
};

/* The asset is an unauthenticated download that becomes executable code inside a host holding a
   repo-scoped GitHub session and a Linear token, and a .vsix installed from a file bypasses the
   signature path the marketplace would apply. GitHub serves `assets[].digest` on the same response
   that gave us the URL, so verifying costs one hash and closes the gap between "the API told us
   about this file" and "this is the file we ran".
 *
 * ⚠️ A missing digest ABORTS. Treating it as "nothing to check" would mean an attacker who can
 * strip a field can also skip the check. */
const verify = (bytes: Uint8Array, digest: string | undefined) => {
  if (!digest?.startsWith("sha256:")) {
    throw new Error("The release asset has no sha256 digest to verify against.");
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== digest.slice("sha256:".length)) {
    throw new Error("The downloaded asset does not match the digest GitHub published for it.");
  }
};

const install = async (context: vscode.ExtensionContext, release: Release) => {
  const response = await fetch(release.asset);
  if (!response.ok) throw new Error(`Downloading ${ASSET} failed with ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  verify(bytes, release.digest);

  /* globalStorageUri, not a temp dir: under Remote-SSH this extension runs in the workspace
     extension host, so this path is on the REMOTE, which is the side the install must land on.
     VS Code does not create the directory itself. */
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const target = vscode.Uri.joinPath(context.globalStorageUri, ASSET);
  await vscode.workspace.fs.writeFile(target, bytes);

  try {
    /* Not in @types/vscode — an internal workbench command, so `executeCommand` types its arguments
       as any[] and the compiler cannot check this call at all. The URI overload was read out of
       microsoft/vscode at tag 1.109.0, which is this extension's declared `engines.vscode` floor,
       and it is unchanged at 1.132.0: `constraint: typeof value === 'string' || value instanceof
       URI`. Raising the floor without re-checking that is how this breaks on a user's machine
       rather than in CI. */
    await vscode.commands.executeCommand("workbench.extensions.installExtension", target);
  } finally {
    await vscode.workspace.fs.delete(target).then(undefined, () => undefined);
  }
};

const offer = async (context: vscode.ExtensionContext, release: Release, current: string) => {
  const choice = await vscode.window.showInformationMessage(
    `Aistos ${release.version} is available — you have ${current}.`,
    "Update",
    "Release notes",
  );
  if (choice === "Release notes") {
    await vscode.env.openExternal(
      vscode.Uri.parse(`https://github.com/${REPO}/releases/tag/${release.tag}`),
    );
    return;
  }
  if (choice !== "Update") return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing Aistos ${release.version}`,
    },
    () => install(context, release),
  );
  const reload = await vscode.window.showInformationMessage(
    `Aistos ${release.version} installed. Reload to use it.`,
    "Reload Window",
  );
  if (reload === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
};

const currentVersion = (context: vscode.ExtensionContext) =>
  String((context.extension.packageJSON as { version?: unknown }).version ?? "0.0.0");

/* Invoked from the palette: always reports, including "you are current". A command that stays
   silent when there is nothing to do is indistinguishable from one that failed. */
export const checkForUpdate = async (context: vscode.ExtensionContext) => {
  const current = currentVersion(context);
  const release = await fetchLatest();
  if (!release) {
    void vscode.window.showWarningMessage("Aistos: could not reach the releases API.");
    return;
  }
  await context.globalState.update(CHECKED_KEY, Date.now());
  if (!isNewer(release.version, current)) {
    void vscode.window.showInformationMessage(`Aistos ${current} is up to date.`);
    return;
  }
  await offer(context, release, current);
};

/* Runs on activation, at most once a day, and NEVER installs on its own — it raises a notification
   and stops. Auto-installing an extension that reloads the window would interrupt work the user was
   in the middle of, and the problem being solved is "nobody knows a new version exists", not
   "updating is too many clicks". */
export const checkForUpdateInBackground = async (context: vscode.ExtensionContext) => {
  const last = context.globalState.get<number>(CHECKED_KEY) ?? 0;
  if (Date.now() - last < DAY_MS) {
    logDebug("update: checked within the last day, skipping");
    return;
  }
  const current = currentVersion(context);
  const release = await fetchLatest();
  await context.globalState.update(CHECKED_KEY, Date.now());
  if (!release || !isNewer(release.version, current)) return;
  logInfo(`update: ${release.version} is available (running ${current})`);
  await offer(context, release, current);
};
