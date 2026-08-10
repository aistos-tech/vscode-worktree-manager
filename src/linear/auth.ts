import * as vscode from "vscode";
import { refreshTokens, revokeToken, runOAuthFlow } from "./oauth";
import { redirectUri } from "./pkce";

const TOKEN_KEY = "linear.token";
const TOKENS_KEY = "linear.tokens";
const CLIENT_ID_KEY = "worktreeManager.linear.clientId";
const WRITE_KEY = "worktreeManager.linear.setStartedOnCreate";

/* THE SEAM. Every consumer calls `linearToken` and nothing else, so the credential mechanism can
   change without touching a caller. Two mechanisms live behind it:

   OAuth with PKCE, preferred, used whenever a client id is configured. The callback is a LOOPBACK
   http server (RFC 8252) rather than a `vscode://` handler — Linear's own docs use
   `http://localhost:3000/oauth/callback` as their redirect example, so none of the
   `https://vscode.dev/redirect` bounce this was once blocked on is needed.

   A personal API key otherwise. It is not merely a fallback for a failed flow: OAuth needs an app
   registered in the workspace, which is a step a teammate may reasonably not want to take, and the
   key path costs them nothing.

   Both live in `context.secrets`, never `globalState`, which is plaintext in state.vscdb.
   SecretStorage does not sync across machines, so each machine signs in once. */

type StoredTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

export const linearClientId = () =>
  vscode.workspace.getConfiguration().get<string>(CLIENT_ID_KEY, "").trim();

/* `read` unless the user has actually enabled the one feature that writes. Requesting `write` at
   first sign-in would take full read-write over everything the user can reach in the workspace
   before they have expressed any opinion — and a grant already made cannot be narrowed by turning
   the setting off afterwards. */
export const requiredScopes = () =>
  vscode.workspace.getConfiguration().get<boolean>(WRITE_KEY, false) ? ["read", "write"] : ["read"];

const readTokens = async (context: vscode.ExtensionContext) => {
  const raw = await context.secrets.get(TOKENS_KEY);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return undefined;
  }
};

const writeTokens = (context: vscode.ExtensionContext, tokens: StoredTokens) =>
  context.secrets.store(TOKENS_KEY, JSON.stringify(tokens));

/* Refreshed a minute early rather than on expiry, so a request cannot start with a token that
   expires mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

export const linearToken = async (context: vscode.ExtensionContext) => {
  const tokens = await readTokens(context);
  if (tokens) {
    const stillValid =
      tokens.expiresAt === undefined || tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now();
    if (stillValid) return tokens.accessToken;

    const clientId = linearClientId();
    if (tokens.refreshToken && clientId) {
      try {
        const refreshed = await refreshTokens({
          clientId,
          refreshToken: tokens.refreshToken,
        });
        await writeTokens(context, refreshed);
        return refreshed.accessToken;
      } catch {
        /* Falls through to "no credential" rather than throwing: an expired refresh is a
           sign-in-again condition, and the caller already renders that as a row. */
        await context.secrets.delete(TOKENS_KEY);
        return undefined;
      }
    }
    return undefined;
  }
  return context.secrets.get(TOKEN_KEY);
};

const signInWithKey = async (context: vscode.ExtensionContext) => {
  const entered = await vscode.window.showInputBox({
    title: "Sign in to Linear — personal API key",
    prompt: "linear.app → Settings → Security & access → Personal API keys",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "A key is required."),
  });
  const token = entered?.trim();
  if (!token) return undefined;
  await context.secrets.store(TOKEN_KEY, token);
  return token;
};

const signInWithOAuth = async (context: vscode.ExtensionContext, clientId: string) => {
  const tokens = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Signing in to Linear…" },
    () => runOAuthFlow({ clientId, scopes: requiredScopes() }),
  );
  await writeTokens(context, tokens);
  /* A key left behind would keep being used by `linearToken`'s fallback branch after the user
     believes they have moved to OAuth. */
  await context.secrets.delete(TOKEN_KEY);
  return tokens.accessToken;
};

const SETUP_URL = "https://linear.app/settings/api/applications/new";

/* Asked rather than assumed. Without a client id the only thing that CAN happen is the key path,
   and silently doing that leaves someone who came looking for OAuth staring at a password box with
   no hint that OAuth exists, that it needs a one-time app registration, or where to do it. */
const chooseMechanism = async () => {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(key) Use a personal API key",
        detail: "Works immediately. linear.app → Settings → Security & access → Personal API keys",
        choice: "key" as const,
      },
      {
        label: "$(shield) Set up OAuth instead",
        detail: `Opens ${SETUP_URL}. Register the redirect URI as ${redirectUri()}, then put the client id in worktreeManager.linear.clientId. Signing out then revokes at Linear.`,
        choice: "oauth" as const,
      },
    ],
    {
      title: "Sign in to Linear",
      placeHolder: "No OAuth client id is configured yet",
      ignoreFocusOut: true,
    },
  );
  return picked?.choice;
};

export const signIn = async (context: vscode.ExtensionContext) => {
  const clientId = linearClientId();
  if (!clientId) {
    const choice = await chooseMechanism();
    if (choice === undefined) return undefined;
    if (choice === "key") return signInWithKey(context);
    /* Opens both halves of the setup: the page that mints the client id, and the setting that
       receives it. Nothing to store yet, so this returns without a credential — deliberately, as
       the next sign-in is the one that succeeds. */
    await vscode.env.openExternal(vscode.Uri.parse(SETUP_URL));
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "worktreeManager.linear.clientId",
    );
    vscode.window.showInformationMessage(
      `Register the redirect URI as exactly ${redirectUri()}, paste the client id into the setting, then run "Aistos: Sign in to Linear" again.`,
    );
    return undefined;
  }
  try {
    return await signInWithOAuth(context, clientId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = await vscode.window.showErrorMessage(
      `Linear sign-in failed — ${message}`,
      "Use an API key instead",
    );
    return fallback ? signInWithKey(context) : undefined;
  }
};

type OnSignOut = () => Thenable<void> | void;

const signOutListeners: OnSignOut[] = [];

/* Caches register here so signing out clears them in the same act. A credential revoked while the
   data it fetched stays on disk is the failure this exists to prevent. */
export const onSignOut = (listener: OnSignOut) => {
  signOutListeners.push(listener);
};

export const signOut = async (context: vscode.ExtensionContext) => {
  /* Revoked at Linear, not merely forgotten locally. This is the concrete reason to prefer OAuth to
     a key: signing out because a machine is suspected compromised should actually invalidate the
     credential. A failure is surfaced rather than swallowed — believing you have revoked when you
     have not is worse than knowing you have not. */
  const tokens = await readTokens(context);
  if (tokens) {
    try {
      await revokeToken(tokens.accessToken);
    } catch (error) {
      vscode.window.showWarningMessage(
        `Signed out locally, but Linear did not confirm revocation — ${error instanceof Error ? error.message : String(error)}. Revoke the authorisation in Linear's settings if this matters.`,
      );
    }
  }
  await context.secrets.delete(TOKENS_KEY);
  await context.secrets.delete(TOKEN_KEY);
  for (const listener of signOutListeners) await listener();
};

export const requireToken = async (context: vscode.ExtensionContext) =>
  (await linearToken(context)) ?? (await signIn(context));
