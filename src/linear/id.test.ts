import { describe, expect, test } from "bun:test";
import { issueIdFor, issueUrl } from "./id";

const idFor = (branch: string, teamKeys?: string[]) => issueIdFor({ branch, teamKeys });

describe("issueIdFor", () => {
  test("reads the identifier off a namespaced branch", () => {
    expect(idFor("dev/acme-42-import-mapping")).toBe("ACME-42");
  });

  test("reads it off an un-namespaced branch", () => {
    expect(idFor("acme-42-import")).toBe("ACME-42");
  });

  /* The alternation, not decoration: requiring a trailing hyphen would miss this entirely. */
  test("reads a bare identifier with no trailing slug", () => {
    expect(idFor("dev/acme-99")).toBe("ACME-99");
  });

  test("uppercases the key", () => {
    expect(idFor("ACME-42-x")).toBe("ACME-42");
  });

  /* The common case, and it must be silent rather than an error: the primary worktree is normally
     id-less, so "no badge" is the everyday state, not an exception. */
  test("returns undefined for a branch with no identifier", () => {
    expect(idFor("staging")).toBeUndefined();
    expect(idFor("dev/configurable-retry-window")).toBeUndefined();
    expect(idFor("fix-technical-issue-bugs")).toBeUndefined();
  });

  test("returns undefined for an empty branch", () => {
    expect(idFor("")).toBeUndefined();
  });

  describe("with known team keys", () => {
    /* What the length bound was wrongly credited with doing. `wip` and `fix` are three characters
       and match the shape; only the workspace's real keys can reject them, and a wrong match is
       the failure this guards — a confident badge linking to a 404. */
    test("rejects a shape match whose key the workspace does not issue", () => {
      expect(idFor("wip-2-something", ["ACME"])).toBeUndefined();
      expect(idFor("fix-2-broken-thing", ["ACME"])).toBeUndefined();
    });

    test("accepts a key the workspace does issue", () => {
      expect(idFor("dev/acme-42-x", ["ACME"])).toBe("ACME-42");
    });

    test("compares keys case-insensitively", () => {
      expect(idFor("acme-42-x", ["acme"])).toBe("ACME-42");
    });

    test("stays permissive when no keys are configured", () => {
      expect(idFor("wip-2-something", [])).toBe("WIP-2");
    });
  });
});

describe("issueUrl", () => {
  test("builds a deep link for the app", () => {
    expect(issueUrl({ identifier: "ACME-42", workspace: "example", openIn: "app" })).toBe(
      "linear://example/issue/ACME-42",
    );
  });

  test("builds an https link for the browser", () => {
    expect(issueUrl({ identifier: "ACME-42", workspace: "example", openIn: "browser" })).toBe(
      "https://linear.app/example/issue/ACME-42",
    );
  });
});

/* Regression: the status bar tooltip is a MarkdownString that interpolates the branch name, and an
   `isTrusted` one executes `command:` URIs. The tooltip is no longer trusted — these pin the other
   half, that an identifier can never itself carry markdown or a scheme. */
describe("identifiers cannot carry markup", () => {
  test("rejects a branch trying to inject a markdown link", () => {
    expect(idFor("x](command:workbench.action.terminal.new)")).toBeUndefined();
  });

  test("rejects a branch whose segment only looks like an identifier", () => {
    expect(idFor("acme-42](command:evil)")).toBeUndefined();
  });

  test("only ever yields KEY-NUMBER", () => {
    const parsed = idFor("dev/acme-42-import");
    expect(parsed).toMatch(/^[A-Z]{1,5}-\d+$/);
  });
});
