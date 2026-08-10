import * as vscode from "vscode";

/* `'github'` is a BUILT-IN provider id, so this needs no extension dependency, no client secret, no
   UriHandler and no refresh handling — the whole of Linear's C3 problem, absent. */
const PROVIDER = "github";
const SCOPES = ["repo"];
const ENDPOINT = "https://api.github.com/graphql";

export class GitHubError extends Error {}

/* Classified from ONE payload rather than by running three searches, so the groups can never
   disagree about which bucket a PR belongs to. */
export type PullRequestGroup = "review" | "mine" | "other";

export type PullRequest = {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  author: string;
  group: PullRequestGroup;
  isDraft: boolean;
  reviewDecision: string | undefined;
};

const session = (createIfNone: boolean) =>
  vscode.authentication.getSession(PROVIDER, SCOPES, { createIfNone });

export const hasGitHubSession = async () => Boolean(await session(false));

export const signInToGitHub = async () => Boolean(await session(true));

/* GraphQL, not REST, and not `gh`.

   `GET /repos/{owner}/{repo}/pulls` accepts only state/head/base/sort/direction/per_page/page — no
   reviewer filter at all. The Search API does support the qualifier, but its PR items expose no
   `head.ref`, which is the very key the join is built on, and recovering it costs one request per
   PR against a 30/minute budget. One GraphQL query returns it in a single round trip.

   `gh` was what the original timing measurement used, but it is not a safe runtime dependency for
   an extension other people install and would need its own PATH handling in the extension host. */
export const fetchPullRequests = async ({ owner, name }: { owner: string; name: string }) => {
  const active = await session(false);
  if (!active) throw new GitHubError("Not signed in to GitHub.");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `bearer ${active.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      /* TWO aliased searches in ONE round trip, plus `viewer`. Reading `reviewRequests` off each
         PR instead would be wrong: `requestedReviewer` is a union of User, Team, Bot and Mannequin,
         so a review requested from a TEAM you belong to — the normal case on a team repo — carries
         no `login` to match against and would silently land in "Other" rather than your queue.
         GitHub resolves team membership server-side for the `review-requested:@me` qualifier, so
         asking it directly is both correct and cheaper than fetching the viewer's team list under
         a `read:org` scope this extension does not request. */
      query: `query PullRequests($all: String!, $review: String!) {
        viewer { login }
        all: search(type: ISSUE, query: $all, first: 100) {
          nodes {
            ... on PullRequest {
              number
              title
              headRefName
              url
              isDraft
              reviewDecision
              author { login }
            }
          }
        }
        review: search(type: ISSUE, query: $review, first: 100) {
          nodes { ... on PullRequest { number } }
        }
      }`,
      variables: {
        /* Every open PR, not just the review queue. The queue is surfaced by ORDERING — it is the
           first group — rather than by exclusion, so the rest stay reachable instead of invisible.
           100 is the search page cap, comfortably above this repo's ~35; beyond that the tail is
           dropped rather than paged, which is a limit worth knowing rather than hiding. */
        all: `repo:${owner}/${name} is:open is:pr`,
        review: `repo:${owner}/${name} is:open is:pr review-requested:@me`,
      },
    }),
  });

  if (response.status === 401) {
    throw new GitHubError("GitHub rejected the session. Sign in again.");
  }
  if (!response.ok) {
    throw new GitHubError(`GitHub returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  const body = payload as {
    data?: {
      viewer?: { login?: string };
      all: {
        nodes: {
          number?: number;
          title?: string;
          headRefName?: string;
          url?: string;
          isDraft?: boolean;
          reviewDecision?: string | null;
          author?: { login?: string } | null;
        }[];
      };
      review: { nodes: { number?: number }[] };
    };
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new GitHubError(body.errors.map((error) => error.message).join("; "));
  }
  if (!body.data) throw new GitHubError("GitHub returned no data.");

  const viewer = body.data.viewer?.login;
  const awaitingReview = new Set(
    body.data.review.nodes.map((node) => node.number).filter((n) => n !== undefined),
  );
  return body.data.all.nodes.flatMap<PullRequest>((node) => {
    if (node.number === undefined || !node.headRefName) return [];
    const requested = awaitingReview.has(node.number);
    const author = node.author?.login ?? "?";
    /* Review beats authorship: a PR you opened and were also asked to review belongs in the queue,
       because the queue is the group with an action attached to it. */
    const group: PullRequestGroup = requested
      ? "review"
      : viewer !== undefined && author === viewer
        ? "mine"
        : "other";
    return [
      {
        number: node.number,
        title: node.title ?? "",
        headRefName: node.headRefName,
        url: node.url ?? "",
        author,
        group,
        isDraft: node.isDraft === true,
        reviewDecision: node.reviewDecision ?? undefined,
      },
    ];
  });
};

/* One PR by branch, for the → preview. A separate small query rather than reusing the list fetch:
   the preview may be opened from the worktrees context, where no PR list has been loaded, and
   making it depend on one would tie a keystroke to a context the user never visited. */
export const fetchPullRequestForBranch = async ({
  owner,
  name,
  branch,
}: {
  owner: string;
  name: string;
  branch: string;
}) => {
  const active = await session(false);
  if (!active) return undefined;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `bearer ${active.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query PrForBranch($owner: String!, $name: String!, $branch: String!) {
        repository(owner: $owner, name: $name) {
          pullRequests(headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) {
            nodes { number title url state isDraft reviewDecision }
          }
        }
      }`,
      variables: { owner, name, branch },
    }),
  });
  if (!response.ok) return undefined;

  const payload: unknown = await response.json();
  const body = payload as {
    data?: {
      repository?: {
        pullRequests: {
          nodes: {
            number?: number;
            title?: string;
            url?: string;
            state?: string;
            isDraft?: boolean;
            reviewDecision?: string | null;
          }[];
        };
      } | null;
    };
  };
  const nodes = body.data?.repository?.pullRequests.nodes ?? [];
  /* Open beats merged beats closed: a branch can carry several PRs over its life, and the one you
     want is the one you could still act on. */
  const best =
    nodes.find((node) => node.state === "OPEN") ??
    nodes.find((node) => node.state === "MERGED") ??
    nodes[0];
  if (!best?.number) return undefined;
  return {
    number: best.number,
    title: best.title ?? "",
    url: best.url ?? "",
    state: best.state ?? "OPEN",
    isDraft: best.isDraft === true,
    reviewDecision: best.reviewDecision ?? undefined,
  };
};
