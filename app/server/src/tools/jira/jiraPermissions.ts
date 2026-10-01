/**
 * Issue-scoped Jira permission checks shared by every mutation builder.
 *
 * Asking `mypermissions` before staging an approval turns a restriction Jira
 * already knows about into an immediate, actionable tool error instead of an
 * approval the user can only watch fail.
 */
import { jiraGet, type JiraApiConfig } from "../../jiraClient.ts";

/** The issue-scoped permissions the Jira tools gate a write on. */
export type JiraIssuePermission =
  "ADD_COMMENTS" | "LINK_ISSUES" | "SCHEDULE_ISSUES";

type JiraPermissionsResponse = {
  permissions?: Record<
    string,
    { key?: string; name?: string; havePermission?: boolean }
  >;
};

export async function assertIssuePermission(
  config: JiraApiConfig,
  issueKey: string,
  permission: JiraIssuePermission,
  action: string,
): Promise<void> {
  const response = await jiraGet<JiraPermissionsResponse>(
    config,
    "/rest/api/3/mypermissions",
    {
      issueKey,
      permissions: permission,
    },
  );
  if (response.permissions?.[permission]?.havePermission === false) {
    throw new Error(
      `Jira does not grant permission to ${action} ${issueKey} (${permission}).`,
    );
  }
}
