import * as vscode from "vscode";

const TOKEN_KEY = "linear.token";

/* THE SEAM. Every consumer calls `linearToken` and nothing else, so the credential mechanism can be
   swapped without touching a single caller — which is the whole point of the shape.

   Today that mechanism is a per-user personal API key in `context.secrets`. The plan's default is
   OAuth with PKCE, and it should still be: OAuth gives revocation and no long-lived credential at
   rest, which a key does not. It is not here yet because C3 rests on an unverified claim —
   `https://vscode.dev/redirect` forwarding an https callback to a THIRD-PARTY `vscode://` URI
   handler is documented only for MCP server auth, and one hands-on report has it refusing a
   non-Microsoft target. The plan itself gates C3 on driving one real round trip first, and that
   spike needs an OAuth app registered in the workspace plus an interactive sign-in.

   So the key path ships first behind this seam, exactly as the plan's own Advisory proposed, and
   OAuth drops in behind `linearToken` when the spike passes. What must NEVER happen is an embedded
   client secret: a .vsix is a zip anyone can open.

   `context.secrets` rather than `globalState` either way — globalState is plaintext in state.vscdb.
   SecretStorage does not sync across machines, so each machine signs in once; the README says so. */
export const linearToken = (context: vscode.ExtensionContext) => context.secrets.get(TOKEN_KEY);

export const signIn = async (context: vscode.ExtensionContext) => {
  const entered = await vscode.window.showInputBox({
    title: "Sign in to Linear",
    prompt: "Personal API key from linear.app → Settings → Security & access → Personal API keys",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() ? undefined : "A key is required."),
  });
  const token = entered?.trim();
  if (!token) return undefined;
  await context.secrets.store(TOKEN_KEY, token);
  return token;
};

type OnSignOut = () => Thenable<void> | void;

const signOutListeners: OnSignOut[] = [];

/* Caches register here so signing out clears them in the same act. A credential revoked while the
   ticket bodies it fetched stay on disk is the failure this exists to prevent — the bodies here
   carry personal data, which this workspace's own rules class as PII. */
export const onSignOut = (listener: OnSignOut) => {
  signOutListeners.push(listener);
};

export const signOut = async (context: vscode.ExtensionContext) => {
  await context.secrets.delete(TOKEN_KEY);
  for (const listener of signOutListeners) await listener();
};

/* Returns a token or prompts for one. Never returns silently empty: a caller that cannot tell
   "no credential" from "empty result" degrades into a blank panel, which reads as a broken feature
   rather than an unconfigured one. */
export const requireToken = async (context: vscode.ExtensionContext) =>
  (await linearToken(context)) ?? (await signIn(context));
