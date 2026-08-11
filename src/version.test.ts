import { describe, expect, test } from "bun:test";
import { isNewer, stripV } from "./version";

/* These two are the whole correctness surface of the update check, and both fail in the same
   direction — a false "an update is available", forever, on every startup. Neither is visible in a
   typecheck and neither shows up until a release exists to compare against. */

describe("stripV", () => {
  test("drops the tag prefix so a tag can be compared with a manifest version", () => {
    expect(stripV("v0.40.0")).toBe("0.40.0");
  });

  /* Releases are minted as `v$VERSION` by CI, but nothing forces a hand-made tag to match. */
  test("leaves an unprefixed tag alone", () => {
    expect(stripV("0.40.0")).toBe("0.40.0");
  });

  test("only strips a LEADING v", () => {
    expect(stripV("v1.0.0-vnext")).toBe("1.0.0-vnext");
  });
});

describe("isNewer", () => {
  test("sees a newer patch, minor and major", () => {
    expect(isNewer("0.39.2", "0.39.1")).toBe(true);
    expect(isNewer("0.40.0", "0.39.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  test("does not offer the version already installed", () => {
    expect(isNewer("0.40.0", "0.40.0")).toBe(false);
  });

  /* The reason a plain `!==` is wrong: a dev build ahead of the last release would be told to
     "update" to an older one, and would keep being told after installing it. */
  test("never offers a downgrade to a build ahead of the release", () => {
    expect(isNewer("0.39.0", "0.40.0")).toBe(false);
  });

  /* The reason a string compare is wrong: "0.9.0" > "0.10.0" lexicographically, so every user on
     0.10.0 would be offered 0.9.0 forever. */
  test("compares parts numerically rather than as text", () => {
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
  });

  test("treats a missing part as zero", () => {
    expect(isNewer("0.40", "0.40.0")).toBe(false);
    expect(isNewer("0.40.1", "0.40")).toBe(true);
  });

  /* Refuses rather than guesses. A tag someone typed by hand is the likely source, and guessing
     yields a permanent update prompt that no install can clear. */
  test("returns false for anything it cannot parse", () => {
    expect(isNewer("latest", "0.40.0")).toBe(false);
    expect(isNewer("0.40.0", "nightly")).toBe(false);
  });
});
