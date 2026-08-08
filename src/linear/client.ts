import type * as vscode from "vscode";
import { linearToken } from "./auth";

const ENDPOINT = "https://api.linear.app/graphql";

/* Raw fetch rather than @linear/sdk: four queries do not justify a generated client, and every
   byte of it would land in the bundle. */

export type LinearIssue = {
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  state: { name: string; type: string };
  assignee?: { displayName: string } | null;
};

export class LinearError extends Error {}

type QueryProps = {
  context: vscode.ExtensionContext;
  query: string;
  variables?: Record<string, unknown>;
};

/* Every failure surfaces its reason. It never degrades to a silently empty result — a 401, an
   expired key and "no issues assigned to you" are three different things, and collapsing them into
   an empty list makes a credential problem look like an empty backlog. */
const request = async <T>({ context, query, variables }: QueryProps): Promise<T> => {
  const token = await linearToken(context);
  if (!token) throw new LinearError("Not signed in to Linear.");

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ query, variables }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new LinearError("Linear rejected the credential (401). Sign in again.");
  }
  if (response.status === 429) {
    throw new LinearError("Linear rate limit reached. Try again shortly.");
  }
  if (!response.ok) {
    throw new LinearError(`Linear returned HTTP ${response.status}.`);
  }

  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new LinearError("Linear returned an unreadable response.");
  }
  const body = payload as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new LinearError(body.errors.map((error) => error.message).join("; "));
  }
  if (!body.data) throw new LinearError("Linear returned no data.");
  return body.data;
};

const ISSUE_FIELDS = `
  identifier
  title
  url
  branchName
  state { name type }
  assignee { displayName }
`;

/* `issue(id: "A-1661")` accepts the human identifier directly, so there is no search round trip. */
export const fetchIssue = async ({
  context,
  identifier,
}: {
  context: vscode.ExtensionContext;
  identifier: string;
}) => {
  const data = await request<{ issue: LinearIssue | null }>({
    context,
    query: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    variables: { id: identifier },
  });
  return data.issue ?? undefined;
};

export const fetchMyIssues = async (context: vscode.ExtensionContext) => {
  const data = await request<{ viewer: { assignedIssues: { nodes: LinearIssue[] } } }>({
    context,
    query: `query MyIssues {
      viewer {
        assignedIssues(
          filter: { state: { type: { neq: "completed" } } }
          orderBy: updatedAt
          first: 50
        ) { nodes { ${ISSUE_FIELDS} } }
      }
    }`,
  });
  return data.viewer.assignedIssues.nodes;
};

/* Only when the issue has not already started. Aïstos runs two started states, In Progress and In
   Review, so an unguarded transition drags an issue back from In Review to In Progress whenever a
   worktree is created to address review comments — and reopens a Done one. */
export const STARTABLE_STATE_TYPES = ["triage", "backlog", "unstarted"] as const;

export const canStart = (issue: Pick<LinearIssue, "state">) =>
  (STARTABLE_STATE_TYPES as readonly string[]).includes(issue.state.type);

export const moveToStarted = async ({
  context,
  identifier,
}: {
  context: vscode.ExtensionContext;
  identifier: string;
}) => {
  const issue = await fetchIssue({ context, identifier });
  if (!issue) throw new LinearError(`${identifier} not found.`);
  if (!canStart(issue)) return { moved: false as const, state: issue.state.name };

  const teams = await request<{
    issue: { team: { states: { nodes: { id: string; type: string; position: number }[] } } };
  }>({
    context,
    query: `query TeamStates($id: String!) {
      issue(id: $id) { team { states { nodes { id type position } } } }
    }`,
    variables: { id: identifier },
  });
  const started = teams.issue.team.states.nodes
    .filter((state) => state.type === "started")
    .sort((left, right) => left.position - right.position)[0];
  if (!started) return { moved: false as const, state: issue.state.name };

  await request({
    context,
    query: `mutation Start($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success }
    }`,
    variables: { id: identifier, stateId: started.id },
  });
  return { moved: true as const, state: issue.state.name };
};
