/**
 * The developer basics of first-run setup (`docs/onboarding.md`): whether Git
 * runs where the assistant's repositories live, and the GitHub token link.
 * Neither changes anything: Git is only asked, and the token itself is entered
 * through `settings_request_input`'s card.
 */
import {
  GITHUB_CLASSIC_PAT_SCOPES,
  GITHUB_CLASSIC_PAT_URL,
} from "@assistant/shared/settingsRegistry";
import { checkoutFilesOn } from "../../checkoutFileAccess.ts";
import { CWD } from "../../config.ts";
import { errorText } from "../../errors.ts";
import { checkoutGitOn, GitCommandError } from "../../gitExec.ts";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  sessionCheckoutSide,
  type CheckoutSide,
} from "../../workers/placement.ts";

const MAX_VERSION_CHARS = 80;
const MAX_IDENTITY_CHARS = 160;

function checkFailed(err: unknown): Error {
  return new Error(
    `Could not check Git (${errorText(err)}). Do not assume it is installed or configured.`,
  );
}

/**
 * Whether `cwd` is a directory on `side`. A spawn's ENOENT means "no git" only
 * then: Node reports a missing working directory with the same error.
 */
async function isDirectoryOn(side: CheckoutSide, cwd: string) {
  try {
    const entry = await checkoutFilesOn(side).inspect(cwd, cwd, {
      follow: true,
    });
    return entry.kind === "directory";
  } catch {
    return false;
  }
}

/** One global identity field: absent when unset (git exits 1), else its value. */
async function globalConfig(
  read: (args: string[]) => Promise<{ stdout: string; code: number }>,
  key: string,
): Promise<string | undefined> {
  const result = await read(["config", "--global", "--get", key]);
  if (result.code === 1) return undefined;
  if (result.code !== 0)
    throw new Error(`git config --global ${key} exited ${result.code}.`);
  return result.stdout.trim().slice(0, MAX_IDENTITY_CHARS) || undefined;
}

const gitSetupReadTool = defineAgentTool<Record<string, unknown>>({
  name: "git_setup_read",
  label: "Check Git",
  description:
    "Check whether Git is installed where your repositories and worktrees run, its version, and whether the global author name and email (user.name, user.email) are set. Read-only: call it before saying anything about Git, report what it returns, and never change the host's Git config yourself.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute(_params, ctx) {
    const side = sessionCheckoutSide(ctx.session.sessionId);
    const { gitReadOnlyOptionalExit } = checkoutGitOn(side);
    const cwd = ctx.session.cwd ?? CWD;
    const read = (args: string[]) =>
      gitReadOnlyOptionalExit(args, cwd, ctx.signal);
    let version;
    try {
      version = await read(["--version"]);
    } catch (err) {
      if (
        err instanceof GitCommandError &&
        err.failureKind === "execution" &&
        /\bENOENT\b/.test(err.message)
      ) {
        if (!(await isDirectoryOn(side, cwd)))
          throw checkFailed(
            `its working directory ${cwd} is missing or unreadable`,
          );
        return jsonResult({
          git: "not_installed",
          note: "No git on the PATH there. Worktrees and commits need it.",
        });
      }
      throw checkFailed(err);
    }
    if (version.code !== 0)
      throw checkFailed(`git --version exited ${version.code}.`);
    try {
      const [name, email] = await Promise.all([
        globalConfig(read, "user.name"),
        globalConfig(read, "user.email"),
      ]);
      return jsonResult({
        git: "installed",
        version: version.stdout.trim().slice(0, MAX_VERSION_CHARS),
        globalIdentity: {
          configured: Boolean(name && email),
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
        },
      });
    } catch (err) {
      throw new Error(
        `Git is installed (${version.stdout.trim().slice(0, MAX_VERSION_CHARS)}), but its global identity could not be read: ${errorText(err)}`,
      );
    }
  },
});

/** GitHub's login rules: 1-39 letters, digits or single inner hyphens. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const githubPatSetupLinkTool = defineAgentTool<{ username: string }>({
  name: "github_pat_setup_link",
  label: "GitHub Token Link",
  description:
    "The link to create the classic GitHub token Pandeck's GitHub features need, its scopes preselected, with what each scope is for. Call it once the user has given their GitHub username; show the link and each scope's purpose in your reply. The token belongs to whichever account is signed in to GitHub in their browser, not to this username.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["username"],
    properties: {
      username: {
        type: "string",
        description: "The user's GitHub username, as they gave it.",
      },
    },
  },
  async execute({ username }) {
    const login = typeof username === "string" ? username.trim() : "";
    if (!GITHUB_LOGIN.test(login))
      throw new Error(
        "That is not a GitHub username: 1-39 letters, digits or single hyphens, not starting or ending with one. Ask the user again.",
      );
    return jsonResult({
      url: GITHUB_CLASSIC_PAT_URL,
      username: login,
      scopes: GITHUB_CLASSIC_PAT_SCOPES,
      note: "The link preselects these scopes; the user may uncheck ones they will not use and should set an expiration. The settings_request_input card for github.token shows this link too.",
    });
  },
});

export const developerSetupTools = [gitSetupReadTool, githubPatSetupLinkTool];
