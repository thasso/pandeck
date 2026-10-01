import type { OrgEvent } from "../../tools/github/githubTools.ts";

/**
 * Deterministic "most specific canonical GitHub link" helpers shared by the
 * event/notification collectors. Both used to emit only the repo root URL, so
 * a day-report link for a PR/issue/commit landed on the whole repo. These pick
 * the specific PR/issue/commit/release/branch target when the payload carries
 * it, and fall back to the repo URL only when nothing more specific exists.
 */

function htmlUrlOf(value: unknown): string | null {
  return value &&
    typeof value === "object" &&
    typeof (value as { html_url?: unknown }).html_url === "string"
    ? (value as { html_url: string }).html_url
    : null;
}

/** The specific target of an org event (PR/issue/review/comment/release/commit/branch), else the repo URL. */
export function eventHtmlLink(
  repo: string | null,
  event: OrgEvent,
): string | null {
  if (!repo) return null;
  const base = `https://github.com/${repo}`;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const specific =
    htmlUrlOf(p.pull_request) ??
    htmlUrlOf(p.issue) ??
    htmlUrlOf(p.review) ??
    htmlUrlOf(p.comment) ??
    htmlUrlOf(p.release);
  if (specific) return specific;
  const type = event.type ?? "";
  if (type === "PushEvent") {
    const head = typeof p.head === "string" ? p.head : null;
    if (head) return `${base}/commit/${head}`;
    const branch =
      typeof p.ref === "string" ? p.ref.replace(/^refs\/heads\//, "") : null;
    return branch ? `${base}/commits/${encodeURIComponent(branch)}` : base;
  }
  if (type === "CreateEvent" || type === "DeleteEvent") {
    const ref = typeof p.ref === "string" ? p.ref : null;
    return ref ? `${base}/tree/${encodeURIComponent(ref)}` : base;
  }
  return base;
}

/** Convert a GitHub REST subject/api URL to its human html_url (pulls→pull, commits→commit), else null. */
export function apiUrlToHtml(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== "api.github.com") return null;
    const m = u.pathname.match(
      /^\/repos\/([^/]+)\/([^/]+)\/(pulls|issues|commits)\/(.+)$/,
    );
    if (!m) return null;
    const [, owner, repo, kind, rest] = m;
    const seg =
      kind === "pulls" ? "pull" : kind === "commits" ? "commit" : "issues";
    return `https://github.com/${owner}/${repo}/${seg}/${rest}`;
  } catch {
    return null;
  }
}

/** A notification's specific issue/PR/commit target when derivable, else the repo URL. */
export function notificationHtmlLink(
  subjectUrl: string | null | undefined,
  repoHtmlUrl: string | null | undefined,
): string | null {
  return apiUrlToHtml(subjectUrl) ?? repoHtmlUrl ?? null;
}
