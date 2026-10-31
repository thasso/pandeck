/** Approval-gated lightweight tag publication for coding sessions. */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { GitTagApprovalBody } from "@assistant/shared";
import { checkoutGitOn, withRepoLock } from "../../gitExec.ts";
import { readRemoteBranchOid, resolvePushTarget } from "../../pushWorkflow.ts";
import { defineAgentTool, jsonResult } from "../../mcp/tool.ts";
import {
  approvalCardReference,
  createApproval,
  registerApprovalExecutor,
} from "../../pendingApprovals.ts";
import {
  sessionCheckoutSide,
  type CheckoutSide,
} from "../../workers/placement.ts";

const PUSH_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND:
    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20",
};
const OID = /^[a-f0-9]{40,64}$/i;

type TagInput = { repoPath: string; tag: string; expectedHead: string };
type TagTarget = {
  side: CheckoutSide;
  repoRoot: string;
  remote: string;
  branch: string;
  pushUrl: string;
  pushUrlFingerprint: string;
};

async function tagOid(
  side: CheckoutSide,
  repoRoot: string,
  remote: string | undefined,
  tag: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const { gitOptional } = checkoutGitOn(side);
  if (!remote) {
    const result = await gitOptional(
      ["rev-parse", "--verify", `refs/tags/${tag}`],
      repoRoot,
      signal,
    );
    return result.code === 0 ? result.stdout.trim().toLowerCase() : undefined;
  }
  const result = await gitOptional(
    ["ls-remote", "--refs", remote, `refs/tags/${tag}`],
    repoRoot,
    signal,
    PUSH_ENV,
  );
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || "Remote tag lookup failed.");
  if (!result.stdout.trim()) return undefined;
  const [oid, ref] = result.stdout.trim().split(/\s+/);
  if (!oid || !OID.test(oid) || ref !== `refs/tags/${tag}`)
    throw new Error("The remote returned an invalid tag ref.");
  return oid.toLowerCase();
}

function displayPushUrl(pushUrl: string): string {
  if (!pushUrl.includes("://")) return pushUrl;
  const url = new URL(pushUrl);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function inspectTarget(
  side: CheckoutSide,
  repoPath: string,
  signal?: AbortSignal,
): Promise<TagTarget> {
  const { git, resolveRepoRoot } = checkoutGitOn(side);
  const repoRoot = await resolveRepoRoot(repoPath, signal);
  const branch = (
    await git(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot, signal)
  ).stdout.trim();
  const target = await resolvePushTarget(
    side,
    repoRoot,
    branch,
    undefined,
    signal,
  );
  if (
    target.upstream?.remote !== target.remote ||
    target.upstream.branch !== branch
  )
    throw new Error(
      "The checked-out branch must track a same-named remote branch.",
    );
  const pushUrls = (
    await git(
      ["remote", "get-url", "--push", "--all", target.remote],
      repoRoot,
      signal,
    )
  ).stdout
    .trim()
    .split("\n");
  if (pushUrls.length !== 1 || !pushUrls[0])
    throw new Error(
      "Tag publication requires exactly one push URL for the upstream remote.",
    );
  const pushUrl = pushUrls[0];
  return {
    side,
    repoRoot,
    remote: target.remote,
    branch,
    pushUrl,
    // Bind the approved destination without persisting credentials from an HTTPS URL.
    pushUrlFingerprint: createHash("sha256").update(pushUrl).digest("hex"),
  };
}

async function validateInput(
  side: CheckoutSide,
  input: TagInput,
  signal?: AbortSignal,
): Promise<void> {
  const { repoPath, tag, expectedHead } = input;
  if (!repoPath || !tag || !expectedHead || !OID.test(expectedHead))
    throw new Error(
      "A repository path, tag and full expected HEAD oid are required.",
    );
  if (!isAbsolute(repoPath)) throw new Error("repoPath must be absolute.");
  if (
    tag.length > 128 ||
    tag.startsWith("-") ||
    (
      await checkoutGitOn(side).gitOptional(
        ["check-ref-format", `refs/tags/${tag}`],
        repoPath,
        signal,
      )
    ).code !== 0
  )
    throw new Error("Invalid git tag name.");
}

async function assertPublishedBranch(
  target: TagTarget,
  head: string,
  signal?: AbortSignal,
) {
  const remoteHead = await readRemoteBranchOid(
    target.side,
    target.repoRoot,
    target.pushUrl,
    target.branch,
    signal,
  );
  if (remoteHead !== head)
    throw new Error(
      "The remote branch does not point to expectedHead; inspect or publish the branch first.",
    );
}

async function assertLocalState(
  target: TagTarget,
  head: string,
  signal?: AbortSignal,
) {
  const { git } = checkoutGitOn(target.side);
  const [currentHead, currentBranch, status] = await Promise.all([
    git(["rev-parse", "HEAD^{commit}"], target.repoRoot, signal),
    git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      target.repoRoot,
      signal,
    ),
    git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      target.repoRoot,
      signal,
    ),
  ]);
  if (
    currentHead.stdout.trim().toLowerCase() !== head ||
    currentBranch.stdout.trim() !== target.branch
  )
    throw new Error(
      "The checkout moved since the requested commit was inspected.",
    );
  if (status.stdout.trim())
    throw new Error("The checkout must be clean before tagging.");
}

/** Execute only after the exact target was approved. Exported for isolated Git regression tests. */
export async function publishApprovedTag(
  input: TagInput & {
    /** The side of the session that proposed the tag. */
    side: CheckoutSide;
    approvedTarget?: Pick<
      TagTarget,
      "remote" | "branch" | "pushUrlFingerprint"
    >;
  },
  signal?: AbortSignal,
) {
  await validateInput(input.side, input, signal);
  const target = await inspectTarget(input.side, input.repoPath, signal);
  const approved = input.approvedTarget;
  if (
    approved &&
    (approved.remote !== target.remote ||
      approved.branch !== target.branch ||
      approved.pushUrlFingerprint !== target.pushUrlFingerprint)
  )
    throw new Error(
      "The checkout or push destination changed since tag approval.",
    );
  const head = input.expectedHead.toLowerCase();
  const existingRemote = await tagOid(
    target.side,
    target.repoRoot,
    target.pushUrl,
    input.tag,
    signal,
  );
  if (existingRemote && existingRemote !== head)
    throw new Error(
      "The remote tag already points to a different object; refusing to move it.",
    );
  // A completed push is read-only on retry, even if the checkout has since moved.
  if (existingRemote === head)
    return {
      status: "already-published",
      tag: input.tag,
      head,
      remote: target.remote,
      repoRoot: target.repoRoot,
    };
  await assertPublishedBranch(target, head, signal);
  const { git, repoLockKey } = checkoutGitOn(target.side);
  const lockKey = await repoLockKey(target.repoRoot);
  await withRepoLock(lockKey, async () => {
    await assertLocalState(target, head, signal);
    const existingLocal = await tagOid(
      target.side,
      target.repoRoot,
      undefined,
      input.tag,
      signal,
    );
    if (existingLocal && existingLocal !== head)
      throw new Error(
        "The local tag points elsewhere. Inspect it and remove it manually before retrying; this tool never moves tags.",
      );
    // Empty old oid is Git's create-only compare-and-swap. It makes a lightweight
    // ref even when tag.gpgSign or tag.annotate is set, without invoking an editor.
    if (!existingLocal)
      await git(
        ["update-ref", `refs/tags/${input.tag}`, head, ""],
        target.repoRoot,
        signal,
      );
  });
  // Explicit opt-outs prevent local push configuration from publishing extra refs
  // or pushing/checking submodule commits along with this single tag ref.
  await git(
    [
      "push",
      "--no-follow-tags",
      "--recurse-submodules=no",
      target.pushUrl,
      `refs/tags/${input.tag}:refs/tags/${input.tag}`,
    ],
    target.repoRoot,
    signal,
    PUSH_ENV,
  );
  const published = await tagOid(
    target.side,
    target.repoRoot,
    target.pushUrl,
    input.tag,
    signal,
  );
  if (published !== head)
    throw new Error(
      "Tag push returned, but the remote tag does not match expectedHead.",
    );
  return {
    status: "published",
    tag: input.tag,
    head,
    remote: target.remote,
    repoRoot: target.repoRoot,
  };
}

export const gitPublishTagTool = defineAgentTool<TagInput>({
  name: "git_publish_tag",
  label: "Propose git tag publication",
  description:
    "Propose creating a lightweight tag at an exact published commit and pushing only that tag to the checked-out branch's upstream remote. Works in ordinary and managed checkouts. Always stages an approval card; no tag is created or pushed until approved, except a previously approved session grant for this exact target. Never moves a tag, pushes a branch, or forces a ref. Requires a clean checkout, same-named upstream branch at expectedHead, and exact local HEAD.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["repoPath", "tag", "expectedHead"],
    properties: {
      repoPath: {
        type: "string",
        minLength: 1,
        description:
          "Absolute path inside the checkout to tag, including a main checkout.",
      },
      tag: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        description:
          "Exact new tag name, e.g. v0.1.0. Existing tags are never moved.",
      },
      expectedHead: {
        type: "string",
        pattern: "^[a-fA-F0-9]{40,64}$",
        description:
          "Full commit oid expected at local HEAD and the upstream branch on the push remote.",
      },
    },
  },
  async execute(input, ctx) {
    const side = sessionCheckoutSide(ctx.session.sessionId);
    await validateInput(side, input, ctx.signal);
    const target = await inspectTarget(side, input.repoPath, ctx.signal);
    const head = input.expectedHead.toLowerCase();
    await assertPublishedBranch(target, head, ctx.signal);
    await assertLocalState(target, head, ctx.signal);
    const existingRemote = await tagOid(
      target.side,
      target.repoRoot,
      target.pushUrl,
      input.tag,
      ctx.signal,
    );
    if (existingRemote)
      throw new Error(
        `The remote tag ${input.tag} already exists. This tool never replaces it.`,
      );
    const existingLocal = await tagOid(
      target.side,
      target.repoRoot,
      undefined,
      input.tag,
      ctx.signal,
    );
    if (existingLocal && existingLocal !== head)
      throw new Error(
        "The local tag points elsewhere. Inspect it and remove it manually before retrying.",
      );
    const body: GitTagApprovalBody = {
      kind: "gitTag",
      repoPath: target.repoRoot,
      remote: target.remote,
      branch: target.branch,
      tag: input.tag,
      targetSha: head,
      pushUrlFingerprint: target.pushUrlFingerprint,
      pushUrlDisplay: displayPushUrl(target.pushUrl),
    };
    const card = createApproval({
      sessionId: ctx.session.sessionId,
      kind: "gitTag",
      title: `Publish tag ${input.tag}`,
      summary: `${target.remote}/${target.branch} ${input.tag} at ${head.slice(0, 12)}`,
      sourceToolCallId: ctx.toolCallId,
      body,
    });
    return {
      ...jsonResult({
        status: "approval-pending",
        approvalId: card.id,
        tag: input.tag,
        head,
        remote: target.remote,
      }),
      content: [
        {
          type: "text",
          text: `Tag ${input.tag} at ${head.slice(0, 12)} is pending approval. Nothing was published. ${approvalCardReference(card)}`,
        },
      ],
      terminate: true,
    };
  },
});

registerApprovalExecutor("gitTag", {
  async execute(card) {
    if (card.body.kind !== "gitTag")
      throw new Error("Mismatched approval body for gitTag.");
    const b = card.body;
    const result = await publishApprovedTag({
      side: sessionCheckoutSide(card.sessionId),
      repoPath: b.repoPath,
      tag: b.tag,
      expectedHead: b.targetSha,
      approvedTarget: {
        remote: b.remote,
        branch: b.branch,
        pushUrlFingerprint: b.pushUrlFingerprint,
      },
    });
    return {
      resultSummary: `${result.status === "published" ? "Published" : "Already published"} ${b.tag} at ${b.targetSha.slice(0, 12)}`,
    };
  },
});
