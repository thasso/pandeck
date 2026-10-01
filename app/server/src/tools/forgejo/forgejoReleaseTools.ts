/**
 * Forgejo release write tool (coding personas only, gate `forgejo`): an
 * approval-gated "cut a release" — annotated tag plus published release notes —
 * against a self-hosted Gitea-compatible instance. Same contract as the PR
 * writes in `./forgejoPrWriteTools.ts`: nothing is written during the model
 * turn; the tool stages a PENDING approval card and the write executes
 * server-side only after the user approves.
 *
 * Publishing a release is not a neutral bookkeeping act — a repository can
 * deploy from the release event (this one does, see `docs/ci-cd.md`), so the
 * approval card is the moment a human decides to ship.
 *
 * The target is resolved to a COMMIT when the proposal is made, and it is that
 * sha the executor tags: the user approves a revision, not "whatever the branch
 * says when I press the button". Two Forgejo details live in the executor:
 *
 *  - the release endpoint creates a LIGHTWEIGHT tag as a side effect, so the tag
 *    endpoint is called first to get an annotated one;
 *  - an existing release is never replaced, and an existing tag is reused only
 *    when it already resolves to this exact commit (a retry after a partial
 *    failure), never when it points elsewhere.
 */
import { defineAgentTool } from "../../mcp/tool.ts";
import { getForgejoToolConfig } from "../../forgejoSettings.ts";
import {
  forgejoRequest,
  ForgejoHttpError,
  type ForgejoApiConfig,
} from "../../forgejoClient.ts";
import { resolveForgejoRepo } from "./forgejoTools.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import type {
  ApprovalCard,
  ForgejoReleaseApprovalBody,
} from "@assistant/shared";

type CreateReleaseParams = {
  repo: string;
  tag: string;
  target?: string;
  name?: string;
  notes?: string;
  prerelease?: boolean;
  draft?: boolean;
};

const PENDING_NOTE =
  "Do not claim it succeeded until the approved result appears.";

/** First line of a commit message, bounded for a one-line card summary. */
const SUBJECT_LIMIT = 120;

export const forgejoCreateReleaseTool = defineAgentTool<CreateReleaseParams>({
  name: "forgejo_create_release",
  label: "Forgejo: Create Release",
  description:
    "Prepare a Forgejo release — an annotated tag plus published notes — for the user to approve. This never writes immediately: it stages a pending approval card, and the tag and release are created only after the user approves. A repository may deploy on its release event, so treat this as shipping, not bookkeeping.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "tag"],
    properties: {
      repo: { type: "string", description: "Repository as 'owner/repo'." },
      tag: {
        type: "string",
        description:
          "Tag to create, exactly as it should appear (for example v0.3.0). An existing release is never replaced; an existing tag is reused only when it already points at the same commit.",
      },
      target: {
        type: "string",
        description:
          "Commit SHA, branch, or tag the release points at; the repository's default branch when omitted. It is resolved to a commit now, and that commit is what gets tagged even if the branch moves before approval.",
      },
      name: {
        type: "string",
        description: "Release title. Defaults to the tag.",
      },
      notes: {
        type: "string",
        description:
          "Release notes (Markdown) — normally this version's changelog section.",
      },
      prerelease: {
        type: "boolean",
        description: "Publish as a prerelease. Defaults to false.",
      },
      draft: {
        type: "boolean",
        description:
          "Create the release unpublished. Defaults to false. A draft does not raise the release event a repository may deploy from.",
      },
    },
  },
  async execute(params, ctx) {
    const config = getForgejoToolConfig();
    const { owner, repo } = resolveForgejoRepo(params.repo);
    const tag = params.tag.trim();
    assertTagName(tag);
    const base = repoBase(owner, repo);

    const existing = await getOrNull<unknown>(
      config,
      `${base}/releases/tags/${encodeURIComponent(tag)}`,
      ctx.signal,
    );
    if (existing !== null)
      throw new Error(
        `${owner}/${repo} already has a release for ${tag}. Releases are never replaced — pick another version.`,
      );

    const targetRef = params.target?.trim() || undefined;
    const commit = await resolveCommit(
      config,
      owner,
      repo,
      targetRef,
      ctx.signal,
    );

    const nameValue = params.name?.trim() || undefined;
    const notesValue = params.notes?.trim() || undefined;
    const body: ForgejoReleaseApprovalBody = {
      kind: "forgejoRelease",
      repo: `${owner}/${repo}`,
      tag,
      targetSha: commit.sha,
      ...(targetRef !== undefined ? { targetRef } : {}),
      ...(commit.subject !== undefined
        ? { targetSubject: commit.subject }
        : {}),
      ...(nameValue !== undefined ? { name: nameValue } : {}),
      ...(notesValue !== undefined ? { notes: notesValue } : {}),
      prerelease: params.prerelease === true,
      draft: params.draft === true,
    };
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "forgejoRelease",
      title: params.draft === true ? "Create draft release" : "Create release",
      summary: `${owner}/${repo} ${tag} at ${commit.sha.slice(0, 8)}`,
      sourceToolCallId: ctx.toolCallId,
      body,
    });
    return {
      content: [
        {
          type: "text",
          text: `Prepared a release proposal (${owner}/${repo} ${tag} at ${commit.sha.slice(0, 8)}) pending your approval. ${PENDING_NOTE} ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

/** API path prefix for one repository (the read module keeps its own copy). */
function repoBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Reject anything git itself would refuse as a tag name, plus the shapes that
 * are legal but hostile in a path (a leading dash, `@{`, a trailing `.lock`).
 * The name reaches the API as JSON, never a shell, so this is about creating a
 * usable tag rather than about escaping.
 */
function assertTagName(tag: string): void {
  if (!tag) throw new Error("tag must be a non-empty tag name.");
  if (
    // eslint-disable-next-line no-control-regex -- git forbids control characters in a ref name, so naming them IS the check.
    /[\u0000-\u001f\u007f]/.test(tag) ||
    /[\s~^:?*[\\]/.test(tag) ||
    tag.includes("..") ||
    tag.includes("@{") ||
    tag.startsWith("-") ||
    tag.startsWith("/") ||
    tag.endsWith("/") ||
    tag.endsWith(".lock")
  )
    throw new Error(`"${tag}" is not a valid git tag name.`);
}

/** GET that answers `null` on 404 instead of throwing — "is it there?" reads. */
async function getOrNull<T>(
  config: ForgejoApiConfig,
  path: string,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const res = await forgejoRequest<T>(config, "GET", path, {
      ...(signal !== undefined ? { signal } : {}),
    });
    return res.data;
  } catch (error) {
    if (error instanceof ForgejoHttpError && error.status === 404) return null;
    throw error;
  }
}

/** Resolve a ref (or the default branch) to the commit a release would tag. */
async function resolveCommit(
  config: ForgejoApiConfig,
  owner: string,
  repo: string,
  ref: string | undefined,
  signal?: AbortSignal,
): Promise<{ sha: string; subject?: string }> {
  const base = repoBase(owner, repo);
  let target = ref;
  if (!target) {
    const info = await forgejoRequest<{ default_branch?: string }>(
      config,
      "GET",
      base,
      { ...(signal !== undefined ? { signal } : {}) },
    );
    target = info.data?.default_branch;
    if (!target)
      throw new Error(
        `${owner}/${repo} reports no default branch; pass an explicit target.`,
      );
  }
  const commit = await getOrNull<{
    sha?: string;
    commit?: { message?: string };
  }>(config, `${base}/git/commits/${encodeURIComponent(target)}`, signal);
  const sha = commit?.sha;
  if (!sha)
    throw new Error(
      `Could not resolve "${target}" to a commit in ${owner}/${repo}.`,
    );
  const subject = (commit?.commit?.message ?? "").split("\n", 1)[0]?.trim();
  return {
    sha,
    ...(subject ? { subject: subject.slice(0, SUBJECT_LIMIT) } : {}),
  };
}

/** Execute an approved Forgejo release against the API. */
registerApprovalExecutor("forgejoRelease", {
  async execute(card: ApprovalCard) {
    if (card.body.kind !== "forgejoRelease")
      throw new Error("Mismatched approval body for forgejoRelease.");
    const b = card.body;
    const config = getForgejoToolConfig();
    const [owner, repoName] = b.repo.split("/");
    const base = repoBase(owner!, repoName!);

    // Re-check under the user's decision, not the proposal's: the window between
    // proposing and approving is exactly when someone else may have tagged.
    const existing = await getOrNull<unknown>(
      config,
      `${base}/releases/tags/${encodeURIComponent(b.tag)}`,
    );
    if (existing !== null)
      throw new Error(
        `Release ${b.tag} already exists; refusing to replace it.`,
      );

    const existingTag = await getOrNull<{ commit?: { sha?: string } }>(
      config,
      `${base}/tags/${encodeURIComponent(b.tag)}`,
    );
    if (existingTag !== null && existingTag.commit?.sha !== b.targetSha)
      throw new Error(
        `Tag ${b.tag} already points at ${existingTag.commit?.sha ?? "an unknown commit"}, not ${b.targetSha}.`,
      );
    if (existingTag === null) {
      // Annotated, and before the release: creating the release first would
      // leave a lightweight tag behind that this endpoint could not upgrade.
      await forgejoRequest(config, "POST", `${base}/tags`, {
        body: {
          tag_name: b.tag,
          target: b.targetSha,
          message: `Release ${b.tag}`,
        },
      });
    }

    const res = await forgejoRequest<{ html_url?: string }>(
      config,
      "POST",
      `${base}/releases`,
      {
        body: {
          tag_name: b.tag,
          target_commitish: b.targetSha,
          name: b.name ?? b.tag,
          body: b.notes ?? "",
          draft: b.draft === true,
          prerelease: b.prerelease === true,
        },
      },
    );
    return {
      resultSummary: `${b.draft === true ? "Drafted" : "Published"} ${b.tag} at ${b.targetSha.slice(0, 8)}`,
      ...(res.data.html_url !== undefined
        ? { resultUrl: res.data.html_url }
        : {}),
    };
  },
});

export const forgejoReleaseWriteTools = [forgejoCreateReleaseTool];
