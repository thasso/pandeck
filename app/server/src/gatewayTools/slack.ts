/**
 * The vault's Slack access view on the edge (Task-1452, Task-1453):
 * `{kind: "slack-oauth", teamId, teamName?, workspaceHost, userId, scope,
 * accessToken, expiresAt}`, decoded and checked whenever the edge reads it and
 * never stored here. Any other `kind`, an Atlassian view included, is
 * refused. Import-free, so the page's status and the Slack tools share it.
 */

/** The decoded access view; `accessToken` only ever goes to Slack. */
export interface SlackAccessView {
  teamId: string;
  teamName?: string;
  workspaceHost: string;
  userId: string;
  scope: string;
  accessToken: string;
  expiresAt: number;
}

const SLACK_KIND = "slack-oauth";
/** As the vault checks them (`gateway/vaultMethods.ts`, `vaultSlack.ts`). */
const TEAM_ID_RE = /^T[A-Z0-9]{2,30}$/;
const USER_ID_RE = /^[UW][A-Z0-9]{2,30}$/;
const WORKSPACE_HOST_RE =
  /^[a-z0-9][a-z0-9-]{0,62}(\.enterprise)?\.slack\.com$/;
const MAX_TEAM_NAME_CHARS = 256;
const MAX_SCOPE_CHARS = 2_048;
const MAX_ACCESS_TOKEN_CHARS = 8_192;
/** Printable ASCII without space: what fits an `Authorization` header. */
const TOKEN_RE = /^[\x21-\x7e]+$/;

/** The vault's answer, checked again; undefined on any failure. */
export function decodeSlackAccessView(
  text: string,
): SlackAccessView | undefined {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return undefined;
  const {
    kind,
    teamId,
    teamName,
    workspaceHost,
    userId,
    scope,
    accessToken,
    expiresAt,
  } = input as Record<string, unknown>;
  if (
    kind !== SLACK_KIND ||
    typeof teamId !== "string" ||
    !TEAM_ID_RE.test(teamId) ||
    (teamName !== undefined &&
      (typeof teamName !== "string" ||
        teamName.length === 0 ||
        teamName.length > MAX_TEAM_NAME_CHARS)) ||
    typeof workspaceHost !== "string" ||
    !WORKSPACE_HOST_RE.test(workspaceHost) ||
    typeof userId !== "string" ||
    !USER_ID_RE.test(userId) ||
    typeof scope !== "string" ||
    scope.length > MAX_SCOPE_CHARS ||
    typeof accessToken !== "string" ||
    accessToken.length > MAX_ACCESS_TOKEN_CHARS ||
    !TOKEN_RE.test(accessToken) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  )
    return undefined;
  return {
    teamId,
    ...(teamName !== undefined ? { teamName } : {}),
    workspaceHost,
    userId,
    scope,
    accessToken,
    expiresAt,
  };
}

/** What the page's status shows of a view: the workspace's name, if any. */
export function describeSlackAccessView(
  text: string,
): { teamName?: string } | undefined {
  const view = decodeSlackAccessView(text);
  if (!view) return undefined;
  return view.teamName !== undefined ? { teamName: view.teamName } : {};
}
