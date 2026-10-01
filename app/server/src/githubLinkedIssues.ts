import { parseGithubIssueRef, type GithubLinkedIssue } from "@assistant/shared";
import { githubRequest, type GithubApiConfig } from "./githubClient.ts";

/**
 * Live title/state for the GitHub issues linked to a Task, one conditional
 * REST read each (an unchanged issue answers `304` and costs no budget). A ref
 * GitHub will not answer — deleted, private to another token — is simply left
 * out, as the Jira lookup does, so the row shows its bare ref.
 */
export async function resolveGithubLinkedIssues(
  config: GithubApiConfig,
  refs: string[],
  signal?: AbortSignal,
): Promise<GithubLinkedIssue[]> {
  const settled = await Promise.all(
    refs.map(async (ref): Promise<GithubLinkedIssue | null> => {
      const parts = parseGithubIssueRef(ref);
      if (!parts) return null;
      try {
        const { data } = await githubRequest<{
          title?: string;
          state?: string;
          html_url?: string;
          pull_request?: { merged_at?: string | null };
        }>(
          config,
          "GET",
          `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/issues/${parts.number}`,
          signal !== undefined ? { signal } : {},
        );
        const isPullRequest = data.pull_request !== undefined;
        return {
          ref,
          title: data.title ?? "",
          state: data.pull_request?.merged_at
            ? "merged"
            : data.state === "closed"
              ? "closed"
              : "open",
          isPullRequest,
          url:
            data.html_url ??
            `https://github.com/${parts.owner}/${parts.repo}/issues/${parts.number}`,
        };
      } catch {
        return null;
      }
    }),
  );
  return settled.filter((issue): issue is GithubLinkedIssue => issue !== null);
}
