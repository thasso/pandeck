/** Slack-owned hosts that serve authenticated/private file downloads. */
export function isSlackPrivateDownloadHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "files.slack.com" ||
    host.endsWith(".files.slack.com") ||
    host === "slack-files.com" ||
    host.endsWith(".slack-files.com") ||
    host === "slack-edge.com" ||
    host.endsWith(".slack-edge.com")
  );
}
