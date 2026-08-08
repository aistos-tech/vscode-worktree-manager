import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* VS Code permits comments and trailing commas in settings.json, so JSON.parse alone would throw
   on a perfectly valid file. Written by hand rather than taking a dependency: this parses one
   known file for two string values, and a bad parse degrades to "no hook", which the caller
   already treats as a refusal on the delete path. */
export const stripJsonc = (text: string) => {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next;
        index += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  /* Trailing commas last, on comment-free text, so a `,` inside a stripped comment cannot
     confuse the lookahead. */
  return out.replace(/,(\s*[}\]])/g, "$1");
};

export const readTrackedSettings = (primaryPath: string) => {
  const file = join(primaryPath, ".vscode", "settings.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(file, "utf8")));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
