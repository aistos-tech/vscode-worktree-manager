import { createHash, randomBytes } from "node:crypto";

/* Pure: no vscode import, so the parts worth proving can actually be tested. */

/* A FIXED port, because the redirect URI must be registered with Linear ahead of time and an
   ephemeral port could never match. High and unusual to make a collision unlikely; if it is taken,
   sign-in fails naming the port rather than silently binding elsewhere. */
export const CALLBACK_PORT = 47823;
export const CALLBACK_PATH = "/callback";

/* 127.0.0.1 rather than `localhost` — RFC 8252 §8.3 prefers the literal loopback IP, because
   `localhost` can resolve through a hosts file or to ::1 while the registered URI must match what
   the browser actually requests. No trailing slash, for the same match-exactly reason. */
export const redirectUri = () => `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

export const base64url = (input: Buffer) =>
  input.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

/* S256, never `plain`. Both are permitted, but plain sends the verifier in the authorize request,
   which defeats the point of PKCE entirely. */
export const makePkce = () => {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
  };
};

export const makeState = () => base64url(randomBytes(16));

export const challengeFor = (verifier: string) =>
  base64url(createHash("sha256").update(verifier).digest());
