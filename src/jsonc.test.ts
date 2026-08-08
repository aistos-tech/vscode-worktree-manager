import { describe, expect, test } from "bun:test";
import { stripJsonc } from "./jsonc";

const parse = (text: string) => JSON.parse(stripJsonc(text)) as Record<string, unknown>;

/* VS Code permits comments and trailing commas in settings.json. A parser that chokes on them
   returns "no hook", and on the delete path "no hook" means the stack is left running — so the
   awkward cases are the ones worth pinning. */
describe("stripJsonc", () => {
  test("leaves plain JSON untouched", () => {
    expect(parse('{"a": 1}')).toEqual({ a: 1 });
  });

  test("strips line comments", () => {
    expect(parse('{\n // why\n "a": 1\n}')).toEqual({ a: 1 });
  });

  test("strips block comments", () => {
    expect(parse('{ /* why\n more */ "a": 1 }')).toEqual({ a: 1 });
  });

  test("strips trailing commas in objects and arrays", () => {
    expect(parse('{"a": [1, 2,], "b": 2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  /* The case a naive regex stripper destroys: the hook command itself is a URL-ish string, and
     `bun run x // y` or a value containing /* would be truncated mid-value. */
  test("does not strip a // sequence inside a string value", () => {
    expect(parse('{"a": "https://example.com/x"}')).toEqual({
      a: "https://example.com/x",
    });
  });

  test("does not strip a block-comment opener inside a string value", () => {
    expect(parse('{"a": "glob /* here"}')).toEqual({ a: "glob /* here" });
  });

  test("keeps an escaped quote from ending the string early", () => {
    expect(parse('{"a": "say \\"hi\\" // not a comment"}')).toEqual({
      a: 'say "hi" // not a comment',
    });
  });

  test("does not treat a comma inside a comment as a trailing comma", () => {
    expect(parse('{"a": 1 /* x, */ }')).toEqual({ a: 1 });
  });

  test("handles the real shape this reads", () => {
    expect(
      parse(`{
        // tracked, so it travels with the repo
        "typescript.tsdk": "node_modules/typescript/lib",
        "worktreeManager.hooks.preDelete": "bun run worktree-hook pre-delete --apply",
      }`)["worktreeManager.hooks.preDelete"],
    ).toBe("bun run worktree-hook pre-delete --apply");
  });
});
