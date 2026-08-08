import { basename } from "node:path";
import type * as vscode from "vscode";
import type { Worktree } from "./worktree";

const PINNED_KEY = "pinnedWorktreeIds";
const COLOUR_KEY = "worktreeColours";
const OPENED_KEY = "worktreeLastOpened";

export const PALETTE = [
  "#FF6B6B",
  "#FF8E4F",
  "#FFB03A",
  "#FFD43B",
  "#D8E64B",
  "#94D82D",
  "#51CF66",
  "#38D9A9",
  "#22CCCC",
  "#3BB2E8",
  "#4D94F7",
  "#7C7CF7",
  "#A97CF7",
  "#CE72EC",
  "#EC72C6",
  "#F76B93",
] as const;

type ColourMap = Record<string, string>;

export type OpenedMap = Record<string, number>;

const hashToIndex = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 0x7fffffff;
  }
  return hash % PALETTE.length;
};

/* WHY: hashing alone collided on 7 of 14 real worktrees — 14 names into 16 buckets makes
   the birthday problem near-certain. Hash only picks the preferred slot; probing forward
   to a free one is what guarantees distinctness. */
type PickColourProps = {
  name: string;
  used: Set<string>;
};

export const pickColour = ({ name, used }: PickColourProps) => {
  const start = hashToIndex(name);
  for (let offset = 0; offset < PALETTE.length; offset += 1) {
    const candidate = PALETTE[(start + offset) % PALETTE.length];
    if (candidate && !used.has(candidate)) return candidate;
  }
  return PALETTE[start] ?? PALETTE[0];
};

type EnsureColoursProps = {
  context: vscode.ExtensionContext;
  worktrees: Worktree[];
};

/* WHY: colour is assigned once and persisted under the rename-stable id, never re-derived.
   Deriving it per-render would make every worktree's colour depend on the current set, so
   adding one worktree would reshuffle the others. */
export const ensureColours = async ({ context, worktrees }: EnsureColoursProps) => {
  const assigned: ColourMap = {
    ...context.globalState.get<ColourMap>(COLOUR_KEY, {}),
  };
  const missing = worktrees.filter((worktree) => !assigned[worktree.id]);
  if (missing.length === 0) return assigned;

  for (const worktree of missing) {
    assigned[worktree.id] = pickColour({
      name: basename(worktree.path),
      used: new Set(Object.values(assigned)),
    });
  }
  await context.globalState.update(COLOUR_KEY, assigned);
  return assigned;
};

/* WHY: stamped on activation rather than on switch, because the switcher is not the only way into
   a worktree — VS Code's recent list, `code <path>` and a reopened window all count as openings,
   and every one of them activates the extension in the folder it landed in. */
type RememberOpenedProps = {
  context: vscode.ExtensionContext;
  id: string;
};

export const rememberOpened = async ({ context, id }: RememberOpenedProps) => {
  const opened = { ...context.globalState.get<OpenedMap>(OPENED_KEY, {}) };
  opened[id] = Date.now();
  await context.globalState.update(OPENED_KEY, opened);
};

export const readPinned = (context: vscode.ExtensionContext) =>
  context.globalState.get<string[]>(PINNED_KEY, []);

export const readOpened = (context: vscode.ExtensionContext) =>
  context.globalState.get<OpenedMap>(OPENED_KEY, {});

export const togglePinned = async (context: vscode.ExtensionContext, id: string) => {
  const pinned = readPinned(context);
  const next = pinned.includes(id) ? pinned.filter((entry) => entry !== id) : [...pinned, id];
  await context.globalState.update(PINNED_KEY, next);
};

/* WHY: the colour map is keyed by worktree id and bounded by the palette, so an entry left
   behind after a delete permanently occupies one of 16 slots. */
type ForgetProps = {
  context: vscode.ExtensionContext;
  id: string;
};

export const forgetWorktree = async ({ context, id }: ForgetProps) => {
  const colours = { ...context.globalState.get<ColourMap>(COLOUR_KEY, {}) };
  delete colours[id];
  await context.globalState.update(COLOUR_KEY, colours);

  const opened = { ...context.globalState.get<OpenedMap>(OPENED_KEY, {}) };
  delete opened[id];
  await context.globalState.update(OPENED_KEY, opened);

  const pinned = readPinned(context);
  if (!pinned.includes(id)) return;
  await context.globalState.update(
    PINNED_KEY,
    pinned.filter((pinnedId) => pinnedId !== id),
  );
};
