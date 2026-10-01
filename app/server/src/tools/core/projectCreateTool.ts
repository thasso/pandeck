/**
 * `project_create`: an approval-gated "new Project". The tool writes nothing
 * during the model turn; it validates the proposal and stages a PENDING card.
 * On approval the executor, in this order:
 *
 *  1. creates the repository on GitHub or Forgejo (with a README commit), or
 *     seeds an existing EMPTY one with a README through the provider API;
 *  2. registers the Project with that repository as its `repoUrl`;
 *  3. clones it into the managed checkout and registers the local path.
 *
 * The README commit matters: a worktree cannot branch from a repository with
 * no commits, so a Project whose repository is empty is a dead end for every
 * coding agent until someone commits by hand.
 *
 * Remote first, because it is the step most likely to fail and leaves nothing
 * local behind when it does. A failure after it names what already exists, so
 * the agent can finish with `project_registry_write` instead of re-creating.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { draftNewProject, upsertProject } from "../../projectRegistry.ts";
import {
  cloneAndRegisterProjectRepo,
  projectRepoDir,
} from "../../projectProvision.ts";
import { existsSync } from "node:fs";
import { gitOptional } from "../../gitExec.ts";
import { broadcastWorktreeList } from "../../worktrees/worktrees.ts";
import { invalidateMainRepo } from "../../worktrees/worktreeResolve.ts";
import { parseRemoteUrl, type RemoteRepoRef } from "../../gitHosting.ts";
import {
  githubRequest,
  resolveAuthenticatedLogin,
  type GithubApiConfig,
} from "../../githubClient.ts";
import {
  getGithubConfigIfAvailable,
  getGithubToolConfig,
} from "../../githubSettings.ts";
import {
  forgejoRequest,
  ForgejoHttpError,
  normalizeForgejoBaseUrl,
  resolveForgejoLogin,
  type ForgejoApiConfig,
} from "../../forgejoClient.ts";
import {
  getForgejoConfigIfAvailable,
  getForgejoToolConfig,
} from "../../forgejoSettings.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import { normalizeProjectPayload } from "./projectRegistryTools.ts";
import type {
  ApprovalCard,
  ProjectCreateApprovalBody,
  ProjectCreateRepository,
  ProjectRepositoryProvider,
} from "@assistant/shared";

type CreateParams = {
  project: Record<string, unknown>;
  repository?: {
    provider?: ProjectRepositoryProvider;
    owner?: string;
    name?: string;
    private?: boolean;
    url?: string;
  };
  clone?: boolean;
};

const PENDING_NOTE =
  "Nothing exists yet. Do not claim it succeeded until the approved result appears.";

/** GitHub's own limit on a repository description. */
const REPO_DESCRIPTION_LIMIT = 350;

/** Both providers accept this; GitHub also rejects a trailing `.git`. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const projectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "key"],
  properties: {
    id: {
      type: "string",
      description:
        "Stable lowercase project id/slug. Derived from name when omitted; also the default repository name and clone folder.",
    },
    name: { type: "string", description: "Human project name." },
    key: {
      type: "string",
      description:
        "Short display key, 2–10 uppercase letters/digits starting with a letter, e.g. RA.",
    },
    description: {
      type: "string",
      description:
        "Durable project description. Its first line also becomes the repository description and README text.",
    },
    color: { type: "string", description: "Optional CSS color." },
    tags: { type: "array", items: { type: "string" } },
    aliases: { type: "array", items: { type: "string" } },
    parentId: { type: "string", description: "Parent project id." },
    jira: {
      type: "array",
      description:
        "Jira links: projectKey for a Jira project, issueKey for one issue.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          projectKey: { type: "string" },
          issueKey: { type: "string" },
          role: {
            type: "string",
            enum: ["primary", "related", "fallback", "customer", "historical"],
          },
          notes: { type: "string" },
        },
      },
    },
  },
} as const;

export const projectCreateTool = defineAgentTool<CreateParams>({
  name: "project_create",
  label: "Project: Create",
  searchHint:
    "new project create repository repo github forgejo initialize empty readme",
  description:
    "Propose a NEW Project for the user to approve on a card: the registry record, optionally a repository, and a clone into the managed checkout. Nothing is written until approval. The repository is either created on GitHub or Forgejo (repository.provider) with a README commit, or an existing one linked by clone URL (repository.url); an existing repository with no commits gets a README commit on approval so worktrees can branch from it. Use project_registry_write to change a Project that already exists.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["project"],
    properties: {
      project: projectSchema,
      repository: {
        type: "object",
        additionalProperties: false,
        description:
          "Omit for a Project without a repository. Set provider to create one, or url to link an existing one — not both.",
        properties: {
          provider: {
            type: "string",
            enum: ["github", "forgejo"],
            description: "Create a new repository on this provider.",
          },
          owner: {
            type: "string",
            description:
              "User or organization to create it under. Defaults to the account of the configured token.",
          },
          name: {
            type: "string",
            description: "Repository name. Defaults to the project id.",
          },
          private: {
            type: "boolean",
            description: "Create it private. Defaults to true.",
          },
          url: {
            type: "string",
            description:
              "Clone URL of an existing repository to link instead of creating one, e.g. ssh://git@host:2222/owner/repo.git.",
          },
        },
      },
      clone: {
        type: "boolean",
        description:
          "Clone the repository into the managed checkout on approval. Defaults to true when a repository is given.",
      },
    },
  },
  async execute(params, ctx) {
    const draft = draftNewProject(
      normalizeProjectPayload(params.project ?? {}),
    );
    const project: ProjectCreateApprovalBody["project"] = {
      id: draft.id,
      name: draft.name,
      key: draft.key,
      ...(draft.description ? { description: draft.description } : {}),
      ...(draft.tags?.length ? { tags: draft.tags } : {}),
      ...(draft.color ? { color: draft.color } : {}),
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      ...(draft.aliases?.length ? { aliases: draft.aliases } : {}),
      ...(draft.jira?.length ? { jira: draft.jira } : {}),
    };

    const repository = params.repository
      ? await proposeRepository(params.repository, project, ctx.signal)
      : undefined;

    const clone = repository !== undefined && params.clone !== false;
    const cloneDir = clone ? projectRepoDir(project.id) : undefined;
    if (cloneDir && existsSync(cloneDir))
      throw new Error(
        `${cloneDir} already exists. Move it away, or pass clone=false and register it with project_registry_write addLocalPath after approval.`,
      );

    const body: ProjectCreateApprovalBody = {
      kind: "projectCreate",
      project,
      ...(repository ? { repository } : {}),
      ...(cloneDir ? { cloneDir } : {}),
    };
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "projectCreate",
      title: "Create project",
      summary: cardSummary(body),
      sourceToolCallId: ctx.toolCallId,
      body,
    });
    return {
      content: [
        {
          type: "text",
          text: `Prepared a new-project proposal (${cardSummary(body)}) pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

/** One line naming everything approval will do. */
function cardSummary(body: ProjectCreateApprovalBody): string {
  const parts = [`${body.project.name} (${body.project.key})`];
  const repo = body.repository;
  if (repo?.mode === "create")
    parts.push(
      `new ${repo.private ? "private" : "public"} ${providerLabel(repo.provider)} repository ${repo.owner}/${repo.name}`,
    );
  else if (repo?.mode === "link")
    parts.push(
      repo.seedReadme
        ? `linking ${repo.url} with a README commit`
        : `linking ${repo.url}`,
    );
  if (body.cloneDir) parts.push(`cloned into ${body.cloneDir}`);
  return parts.join(", ");
}

function providerLabel(provider: ProjectRepositoryProvider): string {
  return provider === "github" ? "GitHub" : "Forgejo";
}

/* ------------------------------- proposal ------------------------------- */

async function proposeRepository(
  input: NonNullable<CreateParams["repository"]>,
  project: ProjectCreateApprovalBody["project"],
  signal?: AbortSignal,
): Promise<ProjectCreateRepository> {
  const url = input.url?.trim();
  if (url && input.provider)
    throw new Error(
      "Pass repository.provider to create a repository OR repository.url to link one, not both.",
    );
  if (url) return proposeLink(url, signal);
  if (!input.provider)
    throw new Error(
      "repository needs provider (create a new one) or url (link an existing one).",
    );

  const name = (input.name?.trim() || project.id).replace(/\.git$/, "");
  if (!REPO_NAME_RE.test(name) || name === "." || name === "..")
    throw new Error(
      `"${name}" is not a valid repository name: use letters, digits, ".", "_" and "-".`,
    );
  const host = hostApi(input.provider);
  const login = await host.login(signal);
  const owner = input.owner?.trim() || login;
  if (await host.repoExists(owner, name, signal))
    throw new Error(
      `${owner}/${name} already exists on ${providerLabel(input.provider)}. Link it with repository.url instead, or pick another name.`,
    );
  const description = repoDescription(project.description);
  return {
    mode: "create",
    provider: input.provider,
    owner,
    name,
    private: input.private !== false,
    ...(description ? { description } : {}),
  };
}

async function proposeLink(
  url: string,
  signal?: AbortSignal,
): Promise<ProjectCreateRepository> {
  assertPlainCloneUrl(url);
  const ref = parseRemoteUrl(url);
  if (!ref) throw new Error("repository.url is not a git clone URL.");
  const hosted = hostedRepoFor(url, ref);
  if (!hosted) return { mode: "link", url };
  const { provider, owner, repo } = hosted;
  const empty = await hostApi(provider).isEmpty(owner, repo, signal);
  return {
    mode: "link",
    url,
    provider,
    repo: `${owner}/${repo}`,
    ...(empty ? { seedReadme: true } : {}),
  };
}

/**
 * The URL lands in the registry, on the card and in the tool result, so it may
 * carry nothing secret: no password or HTTP user (a token often travels as
 * one), no query, no fragment. The error does not echo it for the same reason.
 * An ssh user such as `git@` is an account name, not a credential.
 */
function assertPlainCloneUrl(url: string): void {
  if (!url.includes("://")) return; // scp-like user@host:owner/repo
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("repository.url is not a git clone URL.");
  }
  const http = /^https?:$/i.test(parsed.protocol);
  if (
    parsed.password ||
    (http && parsed.username) ||
    parsed.search ||
    parsed.hash
  )
    throw new Error(
      "repository.url must be a plain clone URL without credentials, query or fragment; git authenticates through the host's own ssh/credential setup.",
    );
}

/**
 * The configured provider serving this URL, and the repository on it. A
 * Forgejo served under a path prefix (`https://host/git`) puts that prefix in
 * front of owner/repo in its HTTPS clone URLs, so it comes off first.
 */
function hostedRepoFor(
  url: string,
  ref: RemoteRepoRef,
):
  | { provider: ProjectRepositoryProvider; owner: string; repo: string }
  | undefined {
  const forgejo = getForgejoConfigIfAvailable();
  if (forgejo) {
    let base: URL | undefined;
    try {
      base = new URL(normalizeForgejoBaseUrl(forgejo.baseUrl));
    } catch {
      // An invalid base URL is an unconfigured provider.
    }
    if (base?.hostname === ref.host) {
      const prefix = base.pathname.replace(/\/+$/, "");
      if (prefix && /^https?:\/\//i.test(url)) {
        const path = new URL(url).pathname;
        const inner = path.startsWith(`${prefix}/`)
          ? parseRemoteUrl(`${base.origin}${path.slice(prefix.length)}`)
          : null;
        if (inner)
          return { provider: "forgejo", owner: inner.owner, repo: inner.repo };
      }
      return { provider: "forgejo", owner: ref.owner, repo: ref.repo };
    }
  }
  if (ref.host === "github.com" && getGithubConfigIfAvailable())
    return { provider: "github", owner: ref.owner, repo: ref.repo };
  return undefined;
}

/** First paragraph of the project description, bounded for a repository. */
function repoDescription(description: string | undefined): string | undefined {
  const first = description?.split(/\n\s*\n/, 1)[0]?.replace(/\s+/g, " ");
  const trimmed = first?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > REPO_DESCRIPTION_LIMIT
    ? `${trimmed.slice(0, REPO_DESCRIPTION_LIMIT - 1)}…`
    : trimmed;
}

function readmeFor(project: ProjectCreateApprovalBody["project"]): string {
  const description = repoDescription(project.description);
  return `# ${project.name}\n${description ? `\n${description}\n` : ""}`;
}

/* ------------------------------- providers ------------------------------ */

interface CreatedRepository {
  cloneUrl: string;
  webUrl?: string;
}

/**
 * The four provider calls this tool makes, behind one shape. GitHub and Forgejo
 * agree on the resources but not on the details: Forgejo reports emptiness as a
 * field while GitHub answers 409 on an empty repository's commits, and Forgejo
 * creates a file with POST where GitHub uses PUT.
 */
interface HostApi {
  login(signal?: AbortSignal): Promise<string>;
  repoExists(
    owner: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  isEmpty(owner: string, name: string, signal?: AbortSignal): Promise<boolean>;
  create(
    repo: Extract<ProjectCreateRepository, { mode: "create" }>,
    login: string,
  ): Promise<CreatedRepository>;
  addReadme(owner: string, name: string, content: string): Promise<void>;
}

function hostApi(provider: ProjectRepositoryProvider): HostApi {
  return provider === "github"
    ? githubHost(getGithubToolConfig())
    : forgejoHost(getForgejoToolConfig());
}

function repoPath(owner: string, name: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/** Create under the token's own account, or under an organization. */
function createPath(owner: string, login: string): string {
  return owner.toLowerCase() === login.toLowerCase()
    ? "/user/repos"
    : `/orgs/${encodeURIComponent(owner)}/repos`;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The GitHub client throws plain errors that carry the status in the message. */
function isGithubStatus(error: unknown, status: number): boolean {
  return (
    error instanceof Error &&
    new RegExp(`HTTP ${status}\\b`).test(error.message)
  );
}

function githubHost(config: GithubApiConfig): HostApi {
  return {
    async login(signal) {
      const login = await resolveAuthenticatedLogin(config, signal);
      if (!login)
        throw new Error(
          "Could not resolve the GitHub account of the configured token.",
        );
      return login;
    },
    async repoExists(owner, name, signal) {
      try {
        await githubRequest(config, "GET", repoPath(owner, name), {
          ...(signal !== undefined ? { signal } : {}),
        });
        return true;
      } catch (error) {
        if (isGithubStatus(error, 404)) return false;
        throw error;
      }
    },
    async isEmpty(owner, name, signal) {
      try {
        await githubRequest(config, "GET", `${repoPath(owner, name)}/commits`, {
          query: { per_page: 1 },
          ...(signal !== undefined ? { signal } : {}),
        });
        return false;
      } catch (error) {
        if (isGithubStatus(error, 409)) return true;
        throw error;
      }
    },
    async create(repo, login) {
      const res = await githubRequest<{ ssh_url?: string; html_url?: string }>(
        config,
        "POST",
        createPath(repo.owner, login),
        {
          body: {
            name: repo.name,
            private: repo.private,
            auto_init: true,
            ...(repo.description ? { description: repo.description } : {}),
          },
        },
      );
      const cloneUrl = res.data.ssh_url;
      if (!cloneUrl)
        throw new Error(
          `GitHub created ${repo.owner}/${repo.name} but reported no clone URL.`,
        );
      return {
        cloneUrl,
        ...(res.data.html_url ? { webUrl: res.data.html_url } : {}),
      };
    },
    async addReadme(owner, name, content) {
      await githubRequest(
        config,
        "PUT",
        `${repoPath(owner, name)}/contents/README.md`,
        { body: { message: "Add README", content: base64(content) } },
      );
    },
  };
}

function forgejoHost(config: ForgejoApiConfig): HostApi {
  return {
    async login(signal) {
      const login = await resolveForgejoLogin(config, signal);
      if (!login)
        throw new Error(
          "Could not resolve the Forgejo account of the configured token. Creating a repository needs a token in Settings → Forgejo.",
        );
      return login;
    },
    async repoExists(owner, name, signal) {
      try {
        await forgejoRequest(config, "GET", repoPath(owner, name), {
          ...(signal !== undefined ? { signal } : {}),
        });
        return true;
      } catch (error) {
        if (error instanceof ForgejoHttpError && error.status === 404)
          return false;
        throw error;
      }
    },
    async isEmpty(owner, name, signal) {
      const res = await forgejoRequest<{ empty?: boolean }>(
        config,
        "GET",
        repoPath(owner, name),
        { ...(signal !== undefined ? { signal } : {}) },
      );
      return res.data.empty === true;
    },
    async create(repo, login) {
      const res = await forgejoRequest<{
        ssh_url?: string;
        clone_url?: string;
        html_url?: string;
      }>(config, "POST", createPath(repo.owner, login), {
        body: {
          name: repo.name,
          private: repo.private,
          auto_init: true,
          readme: "Default",
          default_branch: "main",
          ...(repo.description ? { description: repo.description } : {}),
        },
      });
      // An instance with SSH disabled reports no ssh_url; HTTPS still clones.
      const cloneUrl = res.data.ssh_url || res.data.clone_url;
      if (!cloneUrl)
        throw new Error(
          `Forgejo created ${repo.owner}/${repo.name} but reported no clone URL.`,
        );
      return {
        cloneUrl,
        ...(res.data.html_url ? { webUrl: res.data.html_url } : {}),
      };
    },
    async addReadme(owner, name, content) {
      await forgejoRequest(
        config,
        "POST",
        `${repoPath(owner, name)}/contents/README.md`,
        { body: { message: "Add README", content: base64(content) } },
      );
    },
  };
}

/* ------------------------------- execution ------------------------------ */

registerApprovalExecutor("projectCreate", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "projectCreate")
      throw new Error("Mismatched approval body for projectCreate.");
    const b = card.body;
    // The world may have moved while the card sat pending. Everything that can
    // refuse without side effects refuses here, before a remote write.
    draftNewProject(b.project);
    if (b.cloneDir) {
      const target = projectRepoDir(b.project.id);
      if (target !== b.cloneDir)
        throw new Error(
          `The projects folder changed since this was proposed: the clone would now go to ${target}, not ${b.cloneDir}. Nothing was created; propose it again.`,
        );
      if (existsSync(b.cloneDir))
        throw new Error(
          `${b.cloneDir} appeared since this was proposed. Nothing was created; move it away, or propose again with clone=false.`,
        );
    }

    const repo = b.repository;
    let repoUrl: string | undefined;
    let webUrl: string | undefined;
    const done: string[] = [];
    if (repo?.mode === "create") {
      const host = hostApi(repo.provider);
      const created = await host.create(repo, await host.login());
      repoUrl = created.cloneUrl;
      webUrl = created.webUrl;
      // Recorded now, not at the end: a failed card keeps its body, and after a
      // later failure this URL is what the agent needs to finish by hand.
      b.resultRepoUrl = repoUrl;
      if (webUrl) b.resultWebUrl = webUrl;
      done.push(`created ${repo.owner}/${repo.name}`);
    } else if (repo?.mode === "link") {
      repoUrl = repo.url;
      b.resultRepoUrl = repoUrl;
      if (repo.provider && repo.repo) {
        const [owner, name] = repo.repo.split("/") as [string, string];
        const host = hostApi(repo.provider);
        // Emptiness is re-read now rather than trusted from the proposal: a
        // README on top of history pushed meanwhile would be an unasked-for
        // commit, and a repository emptied meanwhile still needs one.
        if (await host.isEmpty(owner, name)) {
          await host.addReadme(owner, name, readmeFor(b.project));
          done.push(`committed README.md to ${repo.repo}`);
        }
      }
    }

    const step = async <T>(label: string, run: () => Promise<T> | T) => {
      try {
        return await run();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          done.length
            ? `${label} failed after it ${done.join(" and ")}: ${message}`
            : `${label} failed: ${message}`,
        );
      }
    };

    await step("Registering the project", () =>
      upsertProject({ ...b.project, ...(repoUrl ? { repoUrl } : {}) }),
    );
    done.push(`registered project ${b.project.id}`);
    if (b.cloneDir && repoUrl) {
      const cloneDir = b.cloneDir;
      const clone = await step("Cloning the repository", () => {
        // Checked again right before cloning: the clone helper reuses any
        // checkout it finds there, which would register an unrelated repository.
        if (existsSync(cloneDir))
          throw new Error(`${cloneDir} appeared while approval ran.`);
        return cloneAndRegisterProjectRepo(b.project.id);
      });
      invalidateMainRepo(b.project.id);
      void broadcastWorktreeList();
      done.push(`cloned into ${clone.dir}`);
      const head = await gitOptional(
        ["rev-parse", "--verify", "HEAD"],
        clone.dir,
      );
      if (head.code !== 0)
        done.push(
          "but the repository has no commits yet, so no worktree can branch from it until one is pushed",
        );
    }

    const summary = done.join(", ");
    return {
      resultSummary: summary.charAt(0).toUpperCase() + summary.slice(1),
      ...(webUrl ? { resultUrl: webUrl } : {}),
    };
  },
});
