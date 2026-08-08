/* Branch → Linear identifier, and identifier → URL. No network, no credentials, and deliberately
   no import from the client: that is what lets the badge ship before any of the auth work, and it
   is a property worth asserting rather than assuming. */

/* Most worktrees here are already named after a Linear issue, because the branch name is taken from
   Linear's own `branchName` rather than rebuilt from a slug. So the link already exists in the data
   and simply is not surfaced — this reads it back out. */
const IDENTIFIER = /^([a-z]{1,5}-\d+)(?:-|$)/i;

type ParseProps = {
  branch: string;
  /* Known team keys, when the workspace has told us. Empty means "accept any shape". */
  teamKeys?: readonly string[];
};

/* The trailing alternation is load-bearing: requiring a hyphen would miss a bare `a-1700` branch,
   which is a perfectly normal branch name.

   The length bound is NOT load-bearing and must not be relied on. An earlier reading justified
   `{1,5}` as excluding things like `wip-2-something` — it does not, `wip` is three characters and
   matches. All it rejects is a key of six or more letters, which Linear does not issue. What it
   buys against the failure that actually matters — a confident badge linking to a 404 — is nothing.
   `teamKeys` is the real guard: given the workspace's keys, a branch like `fix-2-something` stops
   matching. Without them this stays permissive, and the badge is a link that may not resolve. */
export const issueIdFor = ({ branch, teamKeys }: ParseProps) => {
  const segment = branch.split("/").pop() ?? "";
  const matched = IDENTIFIER.exec(segment)?.[1];
  if (!matched) return undefined;
  const identifier = matched.toUpperCase();
  if (!teamKeys?.length) return identifier;
  const key = identifier.split("-")[0] ?? "";
  return teamKeys.some((known) => known.toUpperCase() === key) ? identifier : undefined;
};

type UrlProps = {
  identifier: string;
  workspace: string;
  openIn: "app" | "browser";
};

/* The trailing title slug in a Linear URL is optional, which is what makes a bare identifier
   enough to build a working link. */
export const issueUrl = ({ identifier, workspace, openIn }: UrlProps) =>
  openIn === "app"
    ? `linear://${workspace}/issue/${identifier}`
    : `https://linear.app/${workspace}/issue/${identifier}`;
