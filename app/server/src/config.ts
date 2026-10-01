import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_INTEGRATION_SECRETS } from "./integrationSecrets.ts";
import {
  IS_PACKAGED_RUNTIME,
  PACKAGED_CONFIG_DIR,
  PACKAGED_PROMPTS_DIR as RUNTIME_PROMPTS_DIR,
  RUNTIME_ASSET_ROOT,
} from "./runtimeAssets.ts";

/**
 * The agent is rooted at the folder you start the server from (the same cwd you
 * would run `pi` in), so project-local `.pi/extensions`, `AGENTS.md` and skills
 * are discovered by the SDK's default resource loader.
 *
 * Because `pnpm --filter <workspace> ...` changes `process.cwd()` to the workspace
 * directory, we prefer `INIT_CWD` — the directory pnpm was invoked from — which
 * is the project root when you run `pnpm run dev` / `pnpm start` there.
 * `ASSISTANT_CWD` overrides everything.
 */
const initCwd = process.env.INIT_CWD;
const usableInitCwd =
  initCwd && existsSync(join(initCwd, "config", "app.json"))
    ? initCwd
    : undefined;
export const CWD = process.env.ASSISTANT_CWD ?? usableInitCwd ?? process.cwd();

export const PORT = Number(process.env.ASSISTANT_PORT ?? 8787);

export const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Whether THIS instance runs the background `git fetch` sweeper
 * (`worktrees/worktreeFetch.ts`). Deliberately opt-in through the production
 * service's own environment rather than the shared base env: PR previews
 * inherit that base env and share production's checkouts, so a flag that
 * travelled with it would have every live preview fetching the same repos.
 */
export const BACKGROUND_FETCH_ENABLED =
  process.env.ASSISTANT_BACKGROUND_FETCH === "1";

/**
 * Same production-only ownership rule for provider-backed PR inventory sync.
 * The ordinary dev server enables it so the feature remains usable there;
 * packaged previews run as production and need the explicit owner flag.
 */
export const BACKGROUND_PR_SYNC_ENABLED =
  process.env.ASSISTANT_BACKGROUND_PR_SYNC === "1" ||
  (process.env.NODE_ENV === "development" &&
    process.env.ASSISTANT_BACKGROUND_PR_SYNC !== "0");

/**
 * In development, bind to all interfaces so the Vite app can be opened from a
 * phone on the same network. Production keeps the safer localhost default unless
 * explicitly overridden.
 */
export const HOST =
  process.env.ASSISTANT_HOST ?? (IS_PROD ? "127.0.0.1" : "0.0.0.0");

/**
 * Shape of the bootstrap config (`config/app.json`). This file holds only static
 * deployment config — user-editable settings are live runtime state and live
 * under `DATA_DIR/settings/app.json` instead. Every field is optional and merged
 * over {@link DEFAULTS}, so an empty or missing file is fine.
 */
interface AppConfigFile {
  /**
   * Root folder for all assistant data (settings, sessions, caches, state).
   * Relative paths resolve against the project root ({@link CWD}).
   */
  dataDir?: string;
  /**
   * Optional externally visible HTTP(S) origin used when a request does not carry
   * enough forwarded-host information, e.g. https://pa.example.net.
   */
  publicBaseUrl?: string;
  /** Static integration configuration. Runtime authorization state still lives under DATA_DIR. */
  google?: {
    oauthClientId?: string;
  };
  /** Static Jira deployment configuration. The Atlassian host is not user-editable; email/token live under DATA_DIR. */
  jira?: {
    host?: string;
  };
  /** Static Confluence deployment configuration. Defaults to the Jira host, which is the same Atlassian site. */
  confluence?: {
    host?: string;
  };
  /** Static Tempo OAuth deployment configuration. Returned tokens/OAuth state stay under DATA_DIR. */
  tempo?: {
    oauthClientId?: string;
  };
  /** Static Slack deployment configuration. OAuth results and browser authorization stay under DATA_DIR. */
  slack?: {
    workspaceHost?: string;
    teamId?: string;
    clientId?: string;
    userScopes?: string[];
    botScopes?: string[];
    /** IANA zone for Slack day filters and local times; unset follows the user's profile timezone. */
    timezone?: string;
    defaultMaxResults?: number;
  };
}

const DEFAULTS = {
  dataDir: "assistant-data",
  publicBaseUrl: "",
  google: {
    oauthClientId: "",
  },
  jira: {
    host: "",
  },
  confluence: {
    host: "",
  },
  tempo: {
    oauthClientId: "",
  },
  slack: {
    workspaceHost: "",
    teamId: "",
    clientId: "",
    // What the Slack tools and shortcut intake need, so they are product
    // defaults rather than deployment config. The installed Slack app must grant
    // at least these; a deployment overrides a list only to match an app that
    // grants a different set.
    userScopes: [
      "users:read.email",
      "bookmarks:read",
      "calls:read",
      "canvases:read",
      "channels:history",
      "channels:read",
      "files:read",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "links:read",
      "lists:read",
      "mpim:history",
      "mpim:read",
      "pins:read",
      "reactions:read",
      "reactions:write",
      "reminders:read",
      "search:read",
      "search:read.files",
      "search:read.im",
      "search:read.mpim",
      "search:read.private",
      "search:read.public",
      "search:read.users",
      "stars:read",
      "team:read",
      "usergroups:read",
      "users:read",
    ],
    botScopes: [
      "assistant:write",
      "channels:history",
      "channels:read",
      "chat:write",
      "commands",
      "emoji:read",
      "files:read",
      "groups:history",
      "groups:read",
      "im:history",
      "im:read",
      "im:write",
      "mpim:read",
      "reactions:read",
      "reactions:write",
      "search:read.files",
      "search:read.im",
      "search:read.mpim",
      "search:read.private",
      "search:read.public",
      "search:read.users",
      "team:read",
      "users:read",
    ],
    timezone: "",
    defaultMaxResults: 20,
  },
} satisfies Required<AppConfigFile>;

/**
 * Path to the unified config file; override with `ASSISTANT_CONFIG`.
 *
 * `ASSISTANT_CWD` is the user's agent workspace, not necessarily the installed
 * application tree. Fall back to the config bundled beside this server source
 * so packaged deployments can use their build-time `config/app.json`.
 */
/**
 * The installed application tree this module belongs to: the repository root in
 * a checkout, the runtime asset root (`ASSISTANT_RUNTIME_DIR`,
 * `$out/libexec/personal-assistant`) in the packaged bundle.
 */
export function packagedAppRootFor(moduleUrl: string): string {
  return IS_PACKAGED_RUNTIME
    ? RUNTIME_ASSET_ROOT
    : resolve(dirname(fileURLToPath(moduleUrl)), "../../..");
}

const cwdConfigPath = join(CWD, "config", "app.json");
const bundledConfigPath = join(PACKAGED_CONFIG_DIR, "app.json");
const CONFIG_PATH =
  process.env.ASSISTANT_CONFIG ??
  (existsSync(cwdConfigPath) ? cwdConfigPath : bundledConfigPath);

function loadConfigFile(): AppConfigFile {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(CONFIG_PATH, "utf8"),
    ) as AppConfigFile;
    return parsed ?? {};
  } catch (err) {
    throw new Error(
      `Failed to load assistant config at ${CONFIG_PATH}: ${String(err)}`,
    );
  }
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(CWD, p);
}

const file = loadConfigFile();

function firstConfigured(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? "").find(Boolean) ?? "";
}

function cleanBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

/**
 * Absolute path to the single folder holding all assistant data. Priority:
 * `DATA_DIR` env (deployment override) → config file `dataDir` → default.
 * Relative values resolve against {@link CWD}.
 */
export const DATA_DIR = resolvePath(
  process.env.DATA_DIR ?? file.dataDir ?? DEFAULTS.dataDir,
);

/** User-owned, Git-backed source library for agent skills. */
export const SKILLS_LIBRARY_DIR = join(DATA_DIR, "skills");

/** Generated per-skill-set runtime layouts; never a source of truth. */
export const SKILLS_RUNTIME_DIR = join(DATA_DIR, "skills-runtime");

/**
 * The APNs auth key that lets this server push to the iOS app.
 *
 * Under `DATA_DIR` by default, like every other credential — but overridable by
 * path because this one is HAND-PROVISIONED rather than obtained through an OAuth
 * flow, which puts it in the same class as `ASSISTANT_TOKEN`: a deployment wants
 * it rendered by its own secret manager (sops-nix and friends write a file and
 * point an env var at it) rather than copied onto the host once and forgotten.
 * See `docs/notifications.md`.
 */
export const APNS_CREDENTIAL_PATH = resolvePath(
  process.env.APNS_CREDENTIAL_FILE ?? join(DATA_DIR, "apns", "credential.json"),
);

/** Optional public origin fallback for generated callback URLs. Request headers win when present. */
export const PUBLIC_BASE_URL = cleanBaseUrl(
  process.env.ASSISTANT_PUBLIC_BASE_URL ??
    file.publicBaseUrl ??
    DEFAULTS.publicBaseUrl,
);

/** Google OAuth client id from static config; its secret comes only from the deployment environment. */
export const GOOGLE_OAUTH_CLIENT_ID = firstConfigured(
  process.env.ASSISTANT_GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  file.google?.oauthClientId,
  DEFAULTS.google.oauthClientId,
);
export const GOOGLE_OAUTH_CLIENT_SECRET =
  CORE_INTEGRATION_SECRETS.googleOauthClientSecret;

/** Static Atlassian/Jira host. Not user-editable; the Jira integration only manages email/token under DATA_DIR. */
export const JIRA_HOST = firstConfigured(
  process.env.ASSISTANT_JIRA_HOST,
  file.jira?.host,
  DEFAULTS.jira.host,
);

/**
 * Static Confluence host. Confluence lives on the same Atlassian site as Jira
 * and shares its credentials, so the Jira host is the default; the override
 * exists for a deployment that splits the two.
 */
export const CONFLUENCE_HOST = firstConfigured(
  process.env.ASSISTANT_CONFLUENCE_HOST,
  file.confluence?.host,
  JIRA_HOST,
);

/** Tempo OAuth client id from static config; its secret comes only from the deployment environment. */
export const TEMPO_OAUTH_CLIENT_ID = firstConfigured(
  process.env.ASSISTANT_TEMPO_OAUTH_CLIENT_ID,
  process.env.TEMPO_OAUTH_CLIENT_ID,
  file.tempo?.oauthClientId,
  DEFAULTS.tempo.oauthClientId,
);
export const TEMPO_OAUTH_CLIENT_SECRET =
  CORE_INTEGRATION_SECRETS.tempoOauthClientSecret;

/**
 * Deployment kill switch for this instance's Slack APP identity
 * (`ASSISTANT_SLACK_APP_DISABLED=1`): the app-level Socket Mode token and the
 * OAuth client credentials resolve empty, whatever the config file or the
 * environment says.
 *
 * Only ONE instance of a deployment may hold a Socket Mode connection: Slack
 * load-balances every event across all open connections, so a second connected
 * instance silently takes a share of the user's real DMs and shortcuts into its
 * own DATA_DIR. PR previews set this switch regardless of which preview-only
 * environment files an operator supplies.
 *
 * Deliberately narrow: user/bot OAuth tokens under DATA_DIR are untouched, so a
 * preview seeded from production keeps working Slack READ tools.
 */
const SLACK_APP_DISABLED = process.env.ASSISTANT_SLACK_APP_DISABLED === "1";

/** Slack app-level credential: the empty string whenever {@link SLACK_APP_DISABLED}. */
function slackAppCredential(...values: Array<string | undefined>): string {
  return SLACK_APP_DISABLED ? "" : firstConfigured(...values);
}

/** Static Slack workspace metadata and read-tool defaults. */
export const SLACK_STATIC_CONFIG = {
  workspaceHost: firstConfigured(
    file.slack?.workspaceHost,
    DEFAULTS.slack.workspaceHost,
  ),
  teamId: firstConfigured(file.slack?.teamId, DEFAULTS.slack.teamId),
  clientId: slackAppCredential(
    process.env.ASSISTANT_SLACK_CLIENT_ID,
    file.slack?.clientId,
    DEFAULTS.slack.clientId,
  ),
  clientSecret: slackAppCredential(CORE_INTEGRATION_SECRETS.slackClientSecret),
  appToken: slackAppCredential(CORE_INTEGRATION_SECRETS.slackAppToken),
  userScopes: (file.slack?.userScopes ?? DEFAULTS.slack.userScopes)
    .map((scope) => scope.trim())
    .filter(Boolean),
  botScopes: (file.slack?.botScopes ?? DEFAULTS.slack.botScopes)
    .map((scope) => scope.trim())
    .filter(Boolean),
  timezone: firstConfigured(file.slack?.timezone, DEFAULTS.slack.timezone),
  defaultMaxResults: Math.max(
    1,
    Math.min(
      100,
      Math.floor(
        Number(
          file.slack?.defaultMaxResults ?? DEFAULTS.slack.defaultMaxResults,
        ) || 20,
      ),
    ),
  ),
};

/**
 * Session stores live under `DATA_DIR/sessions`, split by session type so we
 * can add more kinds (e.g. background jobs) without mixing them with chat.
 */
const SESSIONS_DIR = join(DATA_DIR, "sessions");

export type SessionType =
  | "chat"
  | "personal-assistant"
  | "workshop"
  | "developer"
  | "workflow-coordinator"
  | "claude"
  | "claude-sdk";

/** Absolute directory for a given session type's store. */
function sessionDir(type: SessionType): string {
  return join(SESSIONS_DIR, type);
}

/** Store for the general assistant's chat sessions. */
export const CHAT_SESSION_DIR = sessionDir("chat");

/** Store for the permanent singleton Personal Assistant's sessions. */
export const PERSONAL_ASSISTANT_SESSION_DIR = sessionDir("personal-assistant");

/** Store for the dev-only Workshop sessions that modify the app itself. */
export const WORKSHOP_SESSION_DIR = sessionDir("workshop");

/** Store for the generic prod-capable Developer coding sessions. */
export const DEVELOPER_SESSION_DIR = sessionDir("developer");

/** Store for constrained, worktree-free Workflow Run coordinator sessions. */
export const WORKFLOW_COORDINATOR_SESSION_DIR = sessionDir(
  "workflow-coordinator",
);

/**
 * The prompt assets that ship WITH the installed application, resolved from this
 * module's own location so the path is the same in a checkout
 * (`<repo>/config/prompts`) and in a Nix install
 * (`$out/libexec/personal-assistant/config/prompts`).
 *
 * Deliberately NOT derived from {@link CWD}: prompts are packaged assets, not
 * workspace files. Deriving them from `ASSISTANT_CWD` is what made production
 * (`ASSISTANT_CWD=/home/alice`) and every PR preview ship built-in fallback
 * text for all four personas (Task-262/291).
 */
export function packagedPromptsDirFor(moduleUrl: string): string {
  return join(packagedAppRootFor(moduleUrl), "config", "prompts");
}

/** The packaged prompt-asset directory of THIS installation. */
export const PACKAGED_PROMPTS_DIR = IS_PACKAGED_RUNTIME
  ? RUNTIME_PROMPTS_DIR
  : packagedPromptsDirFor(import.meta.url);

/**
 * Resolve the prompt-asset directory from an explicit override.
 *
 * The override must be an ABSOLUTE existing directory: a relative path would
 * reintroduce the working-directory coupling this resolution exists to remove,
 * and a typo must fail loudly instead of silently falling back to the packaged
 * assets.
 */
export function resolvePromptsDirFrom(
  override: string | undefined,
  packaged = PACKAGED_PROMPTS_DIR,
): string {
  const dir = override?.trim();
  if (!dir) return packaged;
  if (!isAbsolute(dir))
    throw new Error(
      `ASSISTANT_PROMPTS_DIR must be an absolute path (got "${dir}"); ` +
        `unset it to use the packaged prompts at ${packaged}`,
    );
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(
      `ASSISTANT_PROMPTS_DIR is not a directory: ${dir}; ` +
        `unset it to use the packaged prompts at ${packaged}`,
    );
  return dir;
}

/**
 * Where the per-agent system-prompt markdown files live: the packaged assets,
 * unless `ASSISTANT_PROMPTS_DIR` points a development run at another set.
 */
export const PROMPTS_DIR = resolvePromptsDirFrom(
  process.env.ASSISTANT_PROMPTS_DIR,
);
