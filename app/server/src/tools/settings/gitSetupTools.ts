import { CWD } from "../../config.ts";
import { gitReadOnlyOptionalExit, GitCommandError } from "../../gitExec.ts";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";

export const GITHUB_CLASSIC_PAT_SCOPES = [
  "repo",
  "workflow",
  "read:packages",
  "notifications",
] as const;

/** Classic PATs support Packages, Checks and repositories across multiple owners.
 * The classic form has no target-name parameter: it uses the account signed into GitHub. */
export function githubPatCreationUrl(rawUsername: string): string {
  const username = rawUsername.trim();
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username) ||
    username.includes("--")
  )
    throw new Error(
      "Enter a valid GitHub username before creating a token link.",
    );
  const url = new URL("https://github.com/settings/tokens/new");
  url.searchParams.set("description", "Pandeck");
  url.searchParams.set("scopes", GITHUB_CLASSIC_PAT_SCOPES.join(","));
  return url.toString();
}

/** Read-only host Git check for the Personal Assistant's developer setup. */
export const gitSetupReadTool = defineAgentTool<Record<string, never>>({
  name: "git_setup_read",
  label: "Check Git Setup",
  description:
    "Check whether Git runs on the Pandeck server and whether a global Git author name and email are configured. Read-only; does not inspect or change credentials, repositories, or GitHub accounts.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute() {
    let version;
    try {
      version = await gitReadOnlyOptionalExit(["--version"], CWD);
    } catch (error) {
      const missing =
        error instanceof GitCommandError &&
        error.failureKind === "execution" &&
        /ENOENT|not found/i.test(error.message);
      return jsonResult({
        status: missing ? "not_installed" : "check_failed",
        note: missing
          ? "Git was not found in the Pandeck server's PATH."
          : "Pandeck could not run Git; do not assume it is installed or configured.",
      });
    }
    if (version.code !== 0)
      return jsonResult({
        status: "check_failed",
        note: "Git was found but did not answer a version check successfully.",
      });

    try {
      const [name, email] = await Promise.all([
        gitReadOnlyOptionalExit(
          ["config", "--global", "--get", "user.name"],
          CWD,
        ),
        gitReadOnlyOptionalExit(
          ["config", "--global", "--get", "user.email"],
          CWD,
        ),
      ]);
      const configuredName =
        name.code === 0 ? name.stdout.trim().slice(0, 160) : "";
      const configuredEmail =
        email.code === 0 ? email.stdout.trim().slice(0, 160) : "";
      return jsonResult({
        status: "installed",
        version: version.stdout.trim().slice(0, 80),
        globalIdentity: {
          configured: Boolean(configuredName && configuredEmail),
          ...(configuredName ? { name: configuredName } : {}),
          ...(configuredEmail ? { email: configuredEmail } : {}),
        },
        note: "This checks the server's global Git author identity for new repositories; individual repositories may override it.",
      });
    } catch {
      return jsonResult({
        status: "installed",
        version: version.stdout.trim().slice(0, 80),
        globalIdentity: { configured: false, checkFailed: true },
        note: "Git works, but Pandeck could not read the server's global author identity.",
      });
    }
  },
});

const githubPatLinkTool = defineAgentTool<{ username: string }>({
  name: "github_pat_setup_link",
  label: "GitHub Token Link",
  description:
    "Create a GitHub classic PAT link after the user supplies their GitHub login. Prefills repo, workflow, read:packages and notifications scopes for full Pandeck support. The classic form uses the GitHub account signed in to the browser, not the supplied login; confirm they match. Never ask for or return the token in chat.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["username"],
    properties: {
      username: { type: "string", description: "The user's GitHub login." },
    },
  },
  async execute({ username }) {
    if (typeof username !== "string")
      throw new Error("A GitHub username is required.");
    return jsonResult({
      url: githubPatCreationUrl(username),
      tokenType: "classic",
      expectedLogin: username.trim(),
      scopes: GITHUB_CLASSIC_PAT_SCOPES,
      note: "The classic token form uses whichever GitHub account is signed in; verify it matches expectedLogin. repo enables private repository reads/writes; notifications enables notifications; read:packages enables private GitHub Packages/GHCR; workflow is for changing workflow files, not merely reading or rerunning Actions. The user may remove unneeded optional scopes and should set an expiration. Request the token with settings_request_input(path: github.token), never in chat.",
    });
  },
});

export const developerSetupTools = [gitSetupReadTool, githubPatLinkTool];
