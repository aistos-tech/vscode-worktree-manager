import { describe, expect, test } from "bun:test";
import {
  CALLBACK_PATH,
  CALLBACK_PORT,
  challengeFor,
  makePkce,
  makeState,
  redirectUri,
} from "./pkce";

describe("redirectUri", () => {
  /* The registered value has to match byte-for-byte, so it is built in exactly one place and
     pinned here — a drift between what is registered with Linear and what is sent produces
     `redirect_uri_mismatch`, which is opaque from inside the editor. */
  test("is a loopback http URL, which is what Linear's own docs show", () => {
    expect(redirectUri()).toBe(`http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`);
  });

  test("uses 127.0.0.1 rather than the localhost name", () => {
    /* RFC 8252 §8.3 prefers the literal loopback IP: `localhost` can resolve through a hosts file
       or to ::1, and the registered URI must match what the browser actually requests. */
    expect(redirectUri()).toContain("127.0.0.1");
    expect(redirectUri()).not.toContain("localhost");
  });

  test("carries no trailing slash", () => {
    /* VS Code's own loopback helper omits it and providers differ on whether they normalise, so
       the shape is pinned rather than left to chance. */
    expect(redirectUri().endsWith("/")).toBe(false);
  });

  test("is a fixed port, because an ephemeral one could never be pre-registered", () => {
    expect(Number.isInteger(CALLBACK_PORT)).toBe(true);
    expect(CALLBACK_PORT).toBeGreaterThan(1024);
  });
});

describe("makePkce", () => {
  test("derives the challenge from the verifier with S256", () => {
    const { verifier, challenge } = makePkce();
    expect(challengeFor(verifier)).toBe(challenge);
  });

  /* Plain would send the verifier itself in the authorize request, so the challenge differing from
     the verifier is the whole security property — pinned so a "simplification" cannot quietly
     reintroduce plain. */
  test("never sends the verifier as the challenge", () => {
    const { verifier, challenge } = makePkce();
    expect(challenge).not.toBe(verifier);
  });

  test("produces a fresh verifier each time", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier);
  });

  /* RFC 7636 §4.1 requires 43–128 characters. */
  test("produces a verifier of legal length", () => {
    const { verifier } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  test("emits base64url only — no +, / or = to be mangled in a query string", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe("makeState", () => {
  test("produces a fresh value each time", () => {
    expect(makeState()).not.toBe(makeState());
  });

  test("is url-safe", () => {
    expect(makeState()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});
