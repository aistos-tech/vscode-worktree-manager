import { createServer } from "node:http";
import * as vscode from "vscode";
import { CALLBACK_PATH, CALLBACK_PORT, makePkce, makeState, redirectUri } from "./pkce";

/* OAuth 2.0 with PKCE, as a PUBLIC client with no backend and no embedded secret.

   The redirect is a LOOPBACK HTTP server (RFC 8252), not a `vscode://` URI handler. That choice is
   what makes this buildable at all: a `vscode://` callback would need Linear to accept a custom
   scheme, or need the `https://vscode.dev/redirect` bounce — which VS Code operates but documents
   only for MCP server auth, and which has been reported refusing non-Microsoft targets. Linear's own
   OAuth docs use `http://localhost:3000/oauth/callback` as their redirect example, so the ordinary
   native-app flow applies and none of that is needed.

   `client_secret` is optional under PKCE per Linear's token-endpoint table, so the extension embeds
   no secret. It could not safely hold one anyway: a .vsix is a zip anyone can open. */

const AUTHORIZE = "https://linear.app/oauth/authorize";
const TOKEN = "https://api.linear.app/oauth/token";
const REVOKE = "https://api.linear.app/oauth/revoke";

const PAGE = (heading: string, detail: string) =>
  `<!doctype html><meta charset="utf-8"><title>${heading}</title>
   <body style="font:15px/1.6 ui-sans-serif,system-ui;margin:4rem auto;max-width:34rem;color:#1a1a1a">
   <h1 style="font-size:1.25rem">${heading}</h1><p>${detail}</p></body>`;

type ListenResult = { code: string } | { error: string };

/* Resolves on the FIRST request to the callback path and stops listening immediately. A server left
   listening after a completed or abandoned sign-in is an open port on a developer machine that
   accepts anything; the timeout is what guarantees it closes even if the user never returns. */
const listenForCode = ({ state, timeoutMs }: { state: string; timeoutMs: number }) =>
  new Promise<ListenResult>((resolve) => {
    let settled = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }

      const finish = (result: ListenResult, heading: string, detail: string) => {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(PAGE(heading, detail));
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve(result);
      };

      const returned = url.searchParams.get("error");
      if (returned) {
        finish({ error: returned }, "Sign-in failed", "You can close this tab.");
        return;
      }
      /* `state` is what binds this callback to the sign-in that began it. PKCE binds the code
         exchange, but without state any local process could drive this redirect with a code of its
         own choosing. */
      if (url.searchParams.get("state") !== state) {
        finish(
          { error: "state mismatch — the callback did not come from this sign-in" },
          "Sign-in failed",
          "The callback did not match this sign-in. You can close this tab.",
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        finish(
          { error: "no authorization code in the callback" },
          "Sign-in failed",
          "You can close this tab.",
        );
        return;
      }
      finish({ code }, "Signed in to Linear", "You can close this tab and return to VS Code.");
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      resolve({ error: "timed out waiting for the Linear callback" });
    }, timeoutMs);

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        error:
          error.code === "EADDRINUSE"
            ? `port ${CALLBACK_PORT} is already in use, so the callback cannot be received`
            : error.message,
      });
    });

    server.listen(CALLBACK_PORT, "127.0.0.1");
  });

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
};

const readTokenResponse = async (response: Response): Promise<TokenSet> => {
  if (!response.ok) {
    throw new Error(`Linear token endpoint returned HTTP ${response.status}.`);
  }
  const payload: unknown = await response.json();
  const body = payload as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Linear returned no access token.");
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt:
      typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
  };
};

type SignInProps = {
  clientId: string;
  scopes: string[];
};

export const runOAuthFlow = async ({ clientId, scopes }: SignInProps) => {
  const { verifier, challenge } = makePkce();
  const state = makeState();
  const waiting = listenForCode({ state, timeoutMs: 5 * 60_000 });

  const authorize = new URL(AUTHORIZE);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scopes.join(","));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("prompt", "consent");

  /* Triggers VS Code's port forwarding when the extension is running remotely, and is documented as
     a no-op when it is running on the client machine — which is what keeps the registered redirect
     matching byte-for-byte on the desktop case. Not cached: the tunnel it opens can be closed by
     the user at any time. */
  await vscode.env.asExternalUri(
    vscode.Uri.parse(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`),
  );
  await vscode.env.openExternal(vscode.Uri.parse(authorize.toString()));

  const result = await waiting;
  if ("error" in result) throw new Error(result.error);

  const body = new URLSearchParams({
    code: result.code,
    redirect_uri: redirectUri(),
    client_id: clientId,
    code_verifier: verifier,
    grant_type: "authorization_code",
  });
  return readTokenResponse(
    await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }),
  );
};

export const refreshTokens = async ({
  clientId,
  refreshToken,
}: {
  clientId: string;
  refreshToken: string;
}) =>
  readTokenResponse(
    await fetch(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }),
  );

/* Revocation is the reason OAuth is worth preferring to a key at all: signing out here actually
   invalidates the credential rather than merely forgetting it locally. */
export const revokeToken = async (accessToken: string) => {
  const response = await fetch(REVOKE, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Linear revocation returned HTTP ${response.status}.`);
  }
};
