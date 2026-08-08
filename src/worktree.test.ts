import { describe, expect, test } from "bun:test";
import { attributeReason, hasAttribute } from "./worktree";

/* Records are verbatim `git worktree list --porcelain` output, reproduced on git 2.50.1. The
   bare-`locked` case is what a plain `git worktree lock` produces, and it is the case a
   `startsWith("locked ")` guard silently misses. */
const bareLocked = ["worktree /w/a", "HEAD abc", "branch refs/heads/a", "locked"];
const reasonedLocked = ["worktree /w/b", "HEAD def", "branch refs/heads/b", "locked in use by CI"];
const prunable = [
  "worktree /w/c",
  "HEAD 000",
  "prunable gitdir file points to non-existent location",
];
const plain = ["worktree /w/d", "HEAD 111", "branch refs/heads/d"];

describe("hasAttribute", () => {
  test("matches the bare form", () => {
    expect(hasAttribute(bareLocked, "locked")).toBe(true);
  });

  test("matches the reasoned form", () => {
    expect(hasAttribute(reasonedLocked, "locked")).toBe(true);
  });

  test("matches prunable, which only ever carries a reason", () => {
    expect(hasAttribute(prunable, "prunable")).toBe(true);
  });

  test("is absent on a plain worktree", () => {
    expect(hasAttribute(plain, "locked")).toBe(false);
    expect(hasAttribute(plain, "prunable")).toBe(false);
  });

  test("does not match a longer attribute that merely starts the same", () => {
    expect(hasAttribute(["lockedish something"], "locked")).toBe(false);
  });

  test("does not confuse the two attributes", () => {
    expect(hasAttribute(bareLocked, "prunable")).toBe(false);
    expect(hasAttribute(prunable, "locked")).toBe(false);
  });
});

describe("attributeReason", () => {
  test("returns the reason when one was given", () => {
    expect(attributeReason(reasonedLocked, "locked")).toBe("in use by CI");
  });

  test("returns undefined for the bare form, so the message omits the dash", () => {
    expect(attributeReason(bareLocked, "locked")).toBeUndefined();
  });

  test("returns undefined when the attribute is absent", () => {
    expect(attributeReason(plain, "locked")).toBeUndefined();
  });
});
