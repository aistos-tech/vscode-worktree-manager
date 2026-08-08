import { describe, expect, test } from "bun:test";
import { parseRemote } from "./remote";

describe("parseRemote", () => {
  test("parses an ssh remote", () => {
    expect(parseRemote("git@github.com:aistos-tech/debt-collection.git")).toEqual({
      owner: "aistos-tech",
      name: "debt-collection",
    });
  });

  test("parses an https remote", () => {
    expect(parseRemote("https://github.com/aistos-tech/debt-collection.git")).toEqual({
      owner: "aistos-tech",
      name: "debt-collection",
    });
  });

  test("tolerates a missing .git suffix", () => {
    expect(parseRemote("https://github.com/aistos-tech/debt-collection")).toEqual({
      owner: "aistos-tech",
      name: "debt-collection",
    });
  });

  test("tolerates surrounding whitespace from git's output", () => {
    expect(parseRemote("  git@github.com:a/b.git\n")).toEqual({ owner: "a", name: "b" });
  });

  test("keeps a nested repo path intact", () => {
    expect(parseRemote("https://example.com/group/sub/repo.git")?.name).toBe("sub/repo");
  });

  test("returns undefined for something that is not a remote", () => {
    expect(parseRemote("not a url")).toBeUndefined();
    expect(parseRemote("")).toBeUndefined();
  });
});
