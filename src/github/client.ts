import * as vscode from "vscode";

/* `'github'` is a BUILT-IN provider id, so this needs no extension dependency, no client secret, no
   UriHandler and no refresh handling — the whole of Linear's C3 problem, absent. */
const PROVIDER = "github";
const SCOPES = ["repo"];
const ENDPOINT = "https://api.github.com/graphql";

export class GitHubError extends Error {}

export type PullRequest = {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  author: string;
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
export const fetchReviewRequested = async ({ owner, name }: { owner: string; name: string }) => {
  const active = await session(false);
  if (!active) throw new GitHubError("Not signed in to GitHub.");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `bearer ${active.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query Reviews($q: String!) {
        search(type: ISSUE, query: $q, first: 30) {
          nodes {
            ... on PullRequest {
              number
              title
              headRefName
              url
              author { login }
            }
          }
        }
      }`,
      variables: {
        /* Scoped to review, because that is the stated purpose. Measured on this repo:
           `review-requested:@me` returns 3 while all open PRs returns 35, most of them your own —
           a context that lists everything is a scrolling exercise. */
        q: `repo:${owner}/${name} is:open is:pr review-requested:@me`,
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
      search: {
        nodes: {
          number?: number;
          title?: string;
          headRefName?: string;
          url?: string;
          author?: { login?: string } | null;
        }[];
      };
    };
    errors?: { message: string }[];
  };
  if (body.errors?.length) {
    throw new GitHubError(body.errors.map((error) => error.message).join("; "));
  }
  if (!body.data) throw new GitHubError("GitHub returned no data.");

  return body.data.search.nodes.flatMap<PullRequest>((node) =>
    node.number === undefined || !node.headRefName
      ? []
      : [
          {
            number: node.number,
            title: node.title ?? "",
            headRefName: node.headRefName,
            url: node.url ?? "",
            author: node.author?.login ?? "?",
          },
        ],
  );
};
