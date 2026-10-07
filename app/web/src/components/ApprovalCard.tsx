/**
 * @widget ApprovalCard
 * @purpose One generic, interactive approval card for every agent-proposed mutation
 *   (GitHub/Forgejo PR writes, Jira/Tempo edits, commit dry-runs). Shared chrome (title, status
 *   badge, Approve/Reject) switches on `body.kind` for the detail. Store-driven: injected
 *   into snapshot()/re-emitted on attach by the server; resolving executes server-side and
 *   the card reflects pending → executing → executed | failed | rejected. "Approve for
 *   session" also grants the card's operations to the session; a later card they cover is
 *   `autoApproved` and runs on the turn's end without buttons.
 * @payload `approval` DisplayBlock (`ApprovalCard`).
 * @useWhen A mutation tool prepares a proposal or its status changes via approvalUpdate.
 */
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  CheckCheck,
  CircleDot,
  ExternalLink,
  FileText,
  FolderPlus,
  GitCommitHorizontal,
  GitBranch,
  GitMerge,
  GitPullRequestArrow,
  KeyRound,
  MessageSquare,
  SquarePen,
  Sparkles,
  Tag,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import type {
  AccountModelOption,
  ApprovalCard as ApprovalCardData,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalResolutionEdits,
  ForgejoPullRequestApprovalBody,
  ForgejoReleaseApprovalBody,
  GitTagApprovalBody,
  GithubBranchDeleteApprovalBody,
  GithubIssueApprovalBody,
  GithubPullRequestApprovalBody,
  GmailArchiveApprovalBody,
  ManagedPullRequestMergeApprovalBody,
  ProjectCreateApprovalBody,
  SessionSpawnApprovalBody,
  SessionSpawnApprovalItem,
  ThinkingLevel,
} from "@assistant/shared";
import { approvalGrantKeys, approvalGrantLabel } from "@assistant/shared";
import { ErrorNote, Spinner } from "./common/load.tsx";
import { ModelSelect, ThinkingSelect } from "./common/ModelThinkingSelect.tsx";
import { sessionPath } from "../lib/sessionRoutes.ts";
import { ConfluencePageApprovalBody } from "./ConfluencePageApprovalBody.tsx";
import { JiraIssueApprovalBody } from "./JiraIssueApprovalBody.tsx";
import { SettingsInputApprovalBody } from "./SettingsInputApprovalBody.tsx";

/**
 * The two providers keep separate approval kinds (persisted cards must stay
 * readable), but the fields this card renders are the same on both — so one
 * body renderer serves them.
 */
type PullRequestApprovalBody =
  GithubPullRequestApprovalBody | ForgejoPullRequestApprovalBody;

function StatusBadge({ approval }: { approval: ApprovalCardData }) {
  const { status } = approval;
  if (status === "pending" && approval.autoApproved)
    return (
      <span
        className="rounded-full bg-blue-500/15 px-2 py-0.5 text-micro font-medium text-blue-600 dark:text-blue-400"
        title="Approved for this session; runs when the agent's turn ends"
      >
        Queued
      </span>
    );
  if (status === "pending")
    return (
      <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-micro font-medium text-yellow-600 dark:text-yellow-400">
        Pending approval
      </span>
    );
  if (status === "executing")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-micro font-medium text-blue-600 dark:text-blue-400">
        <Spinner size="sm" />
        Executing
      </span>
    );
  if (status === "executed" && approvalHasWarnings(approval))
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 px-2 py-0.5 text-micro font-medium text-yellow-600 dark:text-yellow-400">
        <CheckCircle2 size={9} />
        Done with warnings
      </span>
    );
  if (status === "executed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-micro font-medium text-green-600 dark:text-green-400">
        <CheckCircle2 size={9} />
        Done
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-micro font-medium text-danger">
        <XCircle size={9} />
        Failed
      </span>
    );
  if (status === "superseded")
    return (
      <span
        className="rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted-foreground"
        title="A newer request from this session replaced it"
      >
        Superseded
      </span>
    );
  return (
    <span className="rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted-foreground">
      Rejected
    </span>
  );
}

function approvalHasWarnings(approval: ApprovalCardData): boolean {
  if (approval.status !== "executed") return false;
  if (/warning|failed/i.test(approval.resultSummary ?? "")) return true;
  if (approval.body.kind === "jiraIssue")
    return approval.body.items.some((item) =>
      Boolean(item.warning || item.error),
    );
  if (approval.body.kind === "confluencePage")
    return approval.body.items.some((item) =>
      Boolean(item.warning || item.error),
    );
  if (approval.body.kind === "tempoWorklog")
    return approval.body.items.some((item) => Boolean(item.error));
  if (approval.body.kind === "githubBranchDelete")
    return approval.body.items.some((item) => Boolean(item.error));
  return false;
}

function HeaderIcon({ approval }: { approval: ApprovalCardData }) {
  const cls =
    "flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary";
  if (
    approval.body.kind === "githubPullRequest" ||
    approval.body.kind === "forgejoPullRequest"
  )
    return (
      <div className={cls}>
        {approval.body.operation === "comment" ? (
          <MessageSquare size={14} />
        ) : approval.body.operation === "assign" ? (
          <UserPlus size={14} />
        ) : (
          <GitPullRequestArrow size={14} />
        )}
      </div>
    );
  if (approval.body.kind === "githubIssue")
    return (
      <div className={cls}>
        {approval.body.operation === "comment" ? (
          <MessageSquare size={14} />
        ) : approval.body.operation === "label" ? (
          <Tag size={14} />
        ) : (
          <CircleDot size={14} />
        )}
      </div>
    );
  if (approval.body.kind === "githubBranchDelete")
    return (
      <div className={cls}>
        <Trash2 size={14} />
      </div>
    );
  if (approval.body.kind === "commit")
    return (
      <div className={cls}>
        <GitCommitHorizontal size={14} />
      </div>
    );
  if (approval.body.kind === "managedPullRequestMerge")
    return (
      <div className={cls}>
        <GitMerge size={14} />
      </div>
    );
  if (approval.body.kind === "sessionSpawn")
    return (
      <div className={cls}>
        <Sparkles size={14} />
      </div>
    );
  if (
    approval.body.kind === "forgejoRelease" ||
    approval.body.kind === "gitTag"
  )
    return (
      <div className={cls}>
        <Tag size={14} />
      </div>
    );
  if (approval.body.kind === "confluencePage")
    return (
      <div className={cls}>
        <FileText size={14} />
      </div>
    );
  if (approval.body.kind === "gmailArchive")
    return (
      <div className={cls}>
        <Archive size={14} />
      </div>
    );
  if (approval.body.kind === "projectCreate")
    return (
      <div className={cls}>
        <FolderPlus size={14} />
      </div>
    );
  if (approval.body.kind === "settingsInput")
    return (
      <div className={cls}>
        <KeyRound size={14} />
      </div>
    );
  return (
    <div className={cls}>
      <SquarePen size={14} />
    </div>
  );
}

function PullRequestBody({ body }: { body: PullRequestApprovalBody }) {
  if (body.operation === "create") {
    return (
      <>
        {body.title && (
          <div>
            <span className="text-faint">Title:</span>{" "}
            <span className="text-fg">{body.title}</span>
          </div>
        )}
        <div>
          <span className="text-faint">Merge:</span>{" "}
          <span className="font-mono text-caption text-fg">{body.head}</span> →{" "}
          <span className="font-mono text-caption text-fg">{body.base}</span>
          {body.draft ? " · draft" : ""}
        </div>
        {body.prBody && (
          <div className="line-clamp-4 whitespace-pre-wrap text-caption text-muted-foreground">
            {body.prBody}
          </div>
        )}
      </>
    );
  }
  if (body.operation === "ready") {
    return (
      <div className="text-fg">
        Mark pull request #{body.pullNumber} ready for review. This does not
        merge it.
      </div>
    );
  }
  if (body.operation === "edit") {
    return (
      <>
        <div className="text-faint">
          Replace description on #{body.pullNumber} with:
        </div>
        <div className="line-clamp-6 whitespace-pre-wrap text-caption text-muted-foreground">
          {body.prBody === "" ? "(empty description)" : body.prBody}
        </div>
      </>
    );
  }
  if (body.operation === "review") {
    return (
      <>
        {body.reviewSummary && (
          <div className="whitespace-pre-wrap text-caption text-muted-foreground line-clamp-6">
            {body.reviewSummary}
          </div>
        )}
        {body.inlineComments && body.inlineComments.length > 0 && (
          <div className="space-y-1">
            <div className="text-caption text-faint">
              {body.inlineComments.length} inline comment
              {body.inlineComments.length === 1 ? "" : "s"}:
            </div>
            <ul className="space-y-1">
              {body.inlineComments.slice(0, 8).map((c, i) => (
                <li
                  key={i}
                  className="rounded-md border border-line bg-raised px-2 py-1"
                >
                  <span className="font-mono text-micro text-faint">
                    {c.path}:{c.line}
                  </span>
                  <div className="text-caption text-fg">{c.body}</div>
                  {c.suggestion && (
                    <pre className="mt-1 overflow-x-auto rounded bg-surface px-1.5 py-1 text-micro text-fg">
                      <code>{c.suggestion}</code>
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </>
    );
  }
  if (body.operation === "assign") {
    const teams = (slugs?: string[]) => (slugs ?? []).map((s) => `team:${s}`);
    const rows: { label: string; people: string[] }[] = [
      {
        label: "Request review",
        people: [...(body.addReviewers ?? []), ...teams(body.addReviewerTeams)],
      },
      {
        label: "Cancel review request",
        people: [
          ...(body.removeReviewers ?? []),
          ...teams(body.removeReviewerTeams),
        ],
      },
      { label: "Assign", people: body.addAssignees ?? [] },
      { label: "Unassign", people: body.removeAssignees ?? [] },
    ].filter((row) => row.people.length > 0);
    return (
      <>
        {rows.map((row) => (
          <div key={row.label}>
            <span className="text-faint">{row.label}:</span>{" "}
            <span className="font-mono text-caption text-fg">
              {row.people.join(", ")}
            </span>
          </div>
        ))}
      </>
    );
  }
  return body.commentBody ? (
    <div className="whitespace-pre-wrap text-caption text-muted-foreground line-clamp-6">
      {body.commentBody}
    </div>
  ) : null;
}

function GithubIssueBody({ body }: { body: GithubIssueApprovalBody }) {
  const rows: { label: string; value: string }[] = [
    { label: "Title", value: body.title ?? "" },
    {
      label: "State",
      value:
        body.state === "closed"
          ? `close${body.stateReason === "not_planned" ? " as not planned" : ""}`
          : body.state === "open"
            ? "reopen"
            : "",
    },
    { label: "Labels", value: (body.labels ?? []).join(", ") },
    { label: "Assignees", value: (body.assignees ?? []).join(", ") },
    { label: "Add labels", value: (body.addLabels ?? []).join(", ") },
    { label: "Remove labels", value: (body.removeLabels ?? []).join(", ") },
    { label: "Assign", value: (body.addAssignees ?? []).join(", ") },
    { label: "Unassign", value: (body.removeAssignees ?? []).join(", ") },
  ].filter((row) => row.value);
  const text =
    body.operation === "comment"
      ? body.commentBody
      : body.issueBody === ""
        ? "(empty description)"
        : body.issueBody;
  return (
    <>
      {rows.map((row) => (
        <div key={row.label}>
          <span className="text-faint">{row.label}:</span>{" "}
          <span className="text-fg">{row.value}</span>
        </div>
      ))}
      {text !== undefined && (
        <>
          {body.operation === "edit" && (
            <div className="text-faint">Replace description with:</div>
          )}
          <div className="line-clamp-6 whitespace-pre-wrap text-caption text-muted-foreground">
            {text}
          </div>
        </>
      )}
      {body.newLabels?.length ? (
        <div className="flex items-start gap-1.5 text-caption text-warning">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            Not yet in {body.repo}, GitHub will create:{" "}
            {body.newLabels.join(", ")}
          </span>
        </div>
      ) : null}
    </>
  );
}

function GithubBranchDeleteBody({
  body,
}: {
  body: GithubBranchDeleteApprovalBody;
}) {
  return (
    <ul className="space-y-1.5">
      {body.items.map((item) => (
        <li key={item.branch} className="space-y-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitBranch size={12} className="shrink-0 text-faint" />
            <span className="break-all font-mono text-caption text-fg">
              {item.branch}
            </span>
            <span className="font-mono text-micro text-faint">
              {item.headSha.slice(0, 7)}
            </span>
            {item.deleted ? (
              <span className="text-green-600 dark:text-green-400">
                · deleted
              </span>
            ) : null}
          </div>
          {item.error ? (
            <div className="break-words pl-4 text-caption text-danger">
              {item.error}
            </div>
          ) : null}
          {item.openPullRequests?.map((pull) => (
            <div
              key={`${pull.role}-${pull.number}`}
              className="flex items-start gap-1.5 pl-4 text-caption text-warning"
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <a
                href={pull.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 break-words underline decoration-line underline-offset-2"
              >
                #{pull.number} {pull.title}
              </a>
              <span className="shrink-0 text-faint">
                ({pull.role === "head" ? "its head" : "its base"}; will close)
              </span>
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function GitTagBody({ body }: { body: GitTagApprovalBody }) {
  return (
    <div className="space-y-1 text-caption">
      <div>
        Tag <span className="font-mono text-fg">{body.tag}</span> at{" "}
        <span className="break-all font-mono text-fg">{body.targetSha}</span>
      </div>
      <div>
        Checkout{" "}
        <span className="break-all font-mono text-fg">{body.repoPath}</span>
      </div>
      <div>
        Push to{" "}
        <span className="font-mono text-fg">
          {body.remote}/{body.branch}
        </span>
      </div>
      <div>
        Destination{" "}
        <span className="break-all font-mono text-fg">
          {body.pushUrlDisplay}
        </span>
      </div>
    </div>
  );
}

function ReleaseBody({ body }: { body: ForgejoReleaseApprovalBody }) {
  return (
    <>
      <div>
        <span className="text-faint">Tag:</span>{" "}
        <span className="font-mono text-caption text-fg">{body.tag}</span>
        {body.draft ? " · draft" : ""}
        {body.prerelease ? " · prerelease" : ""}
      </div>
      <div>
        <span className="text-faint">At:</span>{" "}
        <span className="font-mono text-caption text-fg">
          {body.targetSha.slice(0, 8)}
        </span>
        {body.targetRef ? (
          <span className="text-muted-foreground"> ({body.targetRef})</span>
        ) : null}
        {body.targetSubject ? (
          <div className="text-caption text-muted-foreground">
            {body.targetSubject}
          </div>
        ) : null}
      </div>
      {body.notes && (
        <div className="line-clamp-6 whitespace-pre-wrap text-caption text-muted-foreground">
          {body.notes}
        </div>
      )}
    </>
  );
}

/**
 * An agent asking to merge its own managed pull request into the DEFAULT
 * branch. Everything shown is the frozen evidence the decision was taken on;
 * approving re-derives all of it and refuses on any drift, so this card states
 * what was true rather than promising it still is.
 */
function ManagedMergeBody({
  body,
}: {
  body: ManagedPullRequestMergeApprovalBody;
}) {
  const checks = body.checks;
  return (
    <>
      <div>
        <span className="text-faint">Merge:</span>{" "}
        <span className="font-mono text-caption text-fg">
          {body.headBranch}
        </span>{" "}
        →{" "}
        <span className="font-mono text-caption text-fg">
          {body.baseBranch}
        </span>{" "}
        <span className="text-faint">(default branch)</span>
      </div>
      <div className="text-caption text-muted-foreground">
        {body.repo}#{body.number} · {body.method} ·{" "}
        {body.deleteRemoteBranch
          ? "delete the remote branch"
          : "keep the remote branch"}
      </div>
      <div className="text-caption text-faint">
        Head <span className="font-mono">{body.headSha.slice(0, 8)}</span> ·
        checks {checks.state}
        {checks.total !== undefined ? ` (${checks.total})` : ""}
        {checks.truncated
          ? ", truncated"
          : checks.finished
            ? ""
            : ", running"}{" "}
        · review{" "}
        {body.review
          ? body.review.changesRequested
            ? "changes requested"
            : "clear"
          : "unknown"}
        {body.draft ? " · draft" : ""}
      </div>
      <div className="text-caption text-faint">
        Repository allows: {body.supportedMethods.join(", ") || "no method"}
      </div>
      {body.linkedTask ? (
        <div className="text-caption text-faint">
          Task-{body.linkedTask.id}: {body.linkedTask.title}
        </div>
      ) : null}
    </>
  );
}

/** One row's pending changes; absent fields keep what the agent proposed. */
interface SpawnRowEdit {
  skip?: boolean;
  model?: AccountModelOption;
  thinkingLevel?: ThinkingLevel;
}

type SpawnEdits = Record<string, SpawnRowEdit>;

/** The edits worth sending: rows the user actually touched. */
function spawnResolutionEdits(
  edits: SpawnEdits,
): ApprovalResolutionEdits | undefined {
  const items = Object.entries(edits).map(([rowId, edit]) => ({
    rowId,
    ...(edit.skip === undefined ? {} : { skip: edit.skip }),
    ...(edit.model
      ? {
          provider: edit.model.provider,
          modelId: edit.model.id,
          credentialProfileId: edit.model.credentialProfileId,
        }
      : {}),
    ...(edit.thinkingLevel ? { thinkingLevel: edit.thinkingLevel } : {}),
  }));
  return items.length > 0 ? { kind: "sessionSpawn", items } : undefined;
}

/** Where the session will run, as one readable line. */
function spawnTargetLine(item: SessionSpawnApprovalItem): string {
  return [
    item.agentType === "developer" ? "Developer" : "Assistant",
    item.projectName ?? item.projectId,
    item.worktreeName ?? item.worktreeId,
    // The id alone says nothing about what the session is being sent to do; the
    // title is why the proposal carries one.
    item.taskId
      ? item.taskTitle
        ? `Task-${item.taskId}: ${item.taskTitle}`
        : `Task-${item.taskId}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * One proposed session. The runtime controls are the point of the card — the
 * agent only suggested a model — so they are live until the card resolves, and
 * frozen into plain text afterwards.
 */
function SpawnRow({
  item,
  editable,
  models,
  edit,
  onEdit,
  onOpenSession,
}: {
  item: SessionSpawnApprovalItem;
  editable: boolean;
  models: readonly AccountModelOption[];
  edit: SpawnRowEdit | undefined;
  onEdit: (patch: SpawnRowEdit) => void;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const skipped = edit?.skip ?? item.skipped ?? false;
  // What this row will actually run on: the user's pick, or the offered option
  // matching the resolved account/model exactly. Anything less is not this row.
  const selected =
    edit?.model ??
    models.find(
      (model) =>
        model.provider === item.provider &&
        model.id === item.modelId &&
        model.credentialProfileId === item.credentialProfileId,
    );
  // The same model on ANOTHER account (the row's account is disabled, or the
  // list is still loading) has the same thinking ladder, so it may stand in for
  // that one purpose — never for display, which must not name an account this
  // row would not run on.
  const ladderModel =
    selected ??
    models.find(
      (model) => model.provider === item.provider && model.id === item.modelId,
    );
  const thinkingLevel = edit?.thinkingLevel ?? item.thinkingLevel;
  const warning = edit?.model ? undefined : item.modelWarning;

  return (
    <div
      className={`rounded-lg border border-line bg-raised px-2.5 py-2 ${skipped ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-caption font-semibold text-fg">
            {item.title}
          </div>
          <div className="truncate text-caption text-faint">
            {spawnTargetLine(item)}
          </div>
        </div>
        {editable && (
          <button
            type="button"
            onClick={() => onEdit({ skip: !skipped })}
            className="shrink-0 rounded-md border border-line px-1.5 py-0.5 text-micro text-muted-foreground hover:bg-surface hover:text-fg"
          >
            {skipped ? "Include" : "Skip"}
          </button>
        )}
      </div>

      {editable && !skipped ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ModelSelect
            models={[...models]}
            value={
              selected ?? {
                provider: item.provider,
                id: item.modelId,
                credentialProfileId: item.credentialProfileId,
              }
            }
            onChange={(model) => onEdit({ model })}
            placeholder={item.modelName ?? item.modelId}
          />
          {/* With no matched model there is no ladder to offer, and an open
              picker would show only `off` — one click silently downgrading the
              row. Locked says "not yet" instead of offering a wrong answer. */}
          <ThinkingSelect
            model={ladderModel}
            value={thinkingLevel}
            onChange={(level) => onEdit({ thinkingLevel: level })}
            locked={!ladderModel}
            {...(ladderModel
              ? {}
              : {
                  title: "Thinking needs the model list, which is not loaded",
                })}
          />
        </div>
      ) : (
        <div className="mt-1 text-caption text-muted-foreground">
          {[
            selected?.name ?? item.modelName ?? item.modelId,
            selected?.accountName ?? item.accountName,
            `${thinkingLevel} thinking`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}

      {warning && (
        <div className="mt-1 flex items-start gap-1.5 text-caption text-yellow-600 dark:text-yellow-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowPrompt((open) => !open)}
        aria-expanded={showPrompt}
        className="mt-1 text-caption text-primary hover:underline"
      >
        {showPrompt ? "Hide opening message" : "more…"}
      </button>
      {showPrompt && (
        <div className="mt-1 whitespace-pre-wrap rounded-md bg-surface px-2 py-1.5 text-caption text-fg">
          {item.prompt}
        </div>
      )}

      {item.resultSessionId && (
        <div className="mt-1">
          <a
            href={sessionPath(item.resultSessionId)}
            className="text-caption text-primary underline decoration-dotted underline-offset-2 hover:decoration-solid"
            onClick={(event) => {
              const id = item.resultSessionId;
              if (
                !onOpenSession ||
                !id ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onOpenSession(id);
            }}
          >
            Open session
          </a>
        </div>
      )}
      {item.error && <ErrorNote message={item.error} />}
    </div>
  );
}

function SessionSpawnBody({
  body,
  editable,
  models,
  edits,
  onEdit,
  onOpenSession,
}: {
  body: SessionSpawnApprovalBody;
  editable: boolean;
  models: readonly AccountModelOption[];
  edits: SpawnEdits;
  onEdit: (rowId: string, patch: SpawnRowEdit) => void;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="space-y-2">
      {body.items.map((item) => (
        <SpawnRow
          key={item.rowId}
          item={item}
          editable={editable}
          models={models}
          edit={edits[item.rowId]}
          onEdit={(patch) => onEdit(item.rowId, patch)}
          onOpenSession={onOpenSession}
        />
      ))}
    </div>
  );
}

function GmailArchiveBody({ body }: { body: GmailArchiveApprovalBody }) {
  return (
    <div
      className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border border-line"
      role="region"
      tabIndex={0}
      aria-label={`${body.items.length} emails to archive`}
    >
      <ul className="divide-y divide-line">
        {body.items.map((item) => (
          <li key={item.messageId} className="space-y-1 px-2.5 py-2">
            <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] gap-2 text-caption">
              <span className="text-faint">From</span>
              <span className="break-words text-fg">{item.sender}</span>
            </div>
            <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] gap-2 text-caption">
              <span className="text-faint">Subject</span>
              <a
                href={item.gmailUrl}
                target="_blank"
                rel="noreferrer"
                className="break-words text-fg underline decoration-line underline-offset-2 hover:decoration-fg"
              >
                {item.subject}
              </a>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What approval will bring into existence, and after it runs, what did. */
function ProjectCreateBody({ body }: { body: ProjectCreateApprovalBody }) {
  const { project, repository } = body;
  const row = "grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2";
  const mono = "break-all font-mono text-caption text-fg";
  return (
    <div className="space-y-1 text-caption">
      <div className={row}>
        <span className="text-faint">Project</span>
        <span className="break-words text-fg">
          {project.name}{" "}
          <span className="font-mono text-muted-foreground">
            {project.key} · {project.id}
          </span>
        </span>
      </div>
      {project.parentId ? (
        <div className={row}>
          <span className="text-faint">Parent</span>
          <span className="font-mono text-fg">{project.parentId}</span>
        </div>
      ) : null}
      {project.tags?.length ? (
        <div className={row}>
          <span className="text-faint">Tags</span>
          <span className="text-fg">{project.tags.join(", ")}</span>
        </div>
      ) : null}
      {project.jira?.length ? (
        <div className={row}>
          <span className="text-faint">Jira</span>
          <span className="font-mono text-fg">
            {project.jira
              .map((link) => link.issueKey ?? link.projectKey)
              .filter(Boolean)
              .join(", ")}
          </span>
        </div>
      ) : null}
      {repository?.mode === "create" ? (
        <div className={row}>
          <span className="text-faint">Repository</span>
          <span className="text-fg">
            New {repository.private ? "private" : "public"}{" "}
            {repository.provider === "github" ? "GitHub" : "Forgejo"} repository{" "}
            <span className="font-mono">
              {repository.owner}/{repository.name}
            </span>
            , initialized with a README
          </span>
        </div>
      ) : repository?.mode === "link" ? (
        <div className={row}>
          <span className="text-faint">Repository</span>
          <span className="min-w-0">
            <span className={mono}>{repository.url}</span>
            {repository.seedReadme ? (
              <span className="text-muted-foreground">
                {" "}
                · empty, a README commit is added
              </span>
            ) : null}
          </span>
        </div>
      ) : null}
      {repository?.mode === "create" && body.resultRepoUrl ? (
        <div className={row}>
          <span className="text-faint">Created</span>
          {body.resultWebUrl ? (
            <a
              href={body.resultWebUrl}
              target="_blank"
              rel="noreferrer"
              className={`${mono} underline decoration-line underline-offset-2 hover:decoration-fg`}
            >
              {body.resultRepoUrl}
            </a>
          ) : (
            <span className={mono}>{body.resultRepoUrl}</span>
          )}
        </div>
      ) : null}
      {body.cloneDir ? (
        <div className={row}>
          <span className="text-faint">Clone into</span>
          <span className={mono}>{body.cloneDir}</span>
        </div>
      ) : null}
      {project.description ? (
        <div className="line-clamp-6 whitespace-pre-wrap text-muted-foreground">
          {project.description}
        </div>
      ) : null}
    </div>
  );
}

function Body({
  approval,
  spawn,
  onDecide,
  settingsInput,
}: {
  approval: ApprovalCardData;
  /** The card's own Approve/Reject, for a body that offers them elsewhere too. */
  onDecide: ((decision: ApprovalDecision) => void) | undefined;
  /** A settings-input card's own controls, which replace the footer. */
  settingsInput: {
    active: boolean;
    busy: "submit" | "dismiss" | null;
    onSubmit: (value: string) => void;
    onDismiss: () => void;
  };
  spawn: {
    editable: boolean;
    models: readonly AccountModelOption[];
    edits: SpawnEdits;
    onEdit: (rowId: string, patch: SpawnRowEdit) => void;
    onOpenSession?: ((id: string) => void) | undefined;
  };
}) {
  const b = approval.body;
  if (b.kind === "githubPullRequest" || b.kind === "forgejoPullRequest")
    return <PullRequestBody body={b} />;
  if (b.kind === "githubIssue") return <GithubIssueBody body={b} />;
  if (b.kind === "githubBranchDelete")
    return <GithubBranchDeleteBody body={b} />;
  if (b.kind === "forgejoRelease") return <ReleaseBody body={b} />;
  if (b.kind === "gitTag") return <GitTagBody body={b} />;
  if (b.kind === "sessionSpawn")
    return (
      <SessionSpawnBody
        body={b}
        editable={spawn.editable}
        models={spawn.models}
        edits={spawn.edits}
        onEdit={spawn.onEdit}
        onOpenSession={spawn.onOpenSession}
      />
    );
  if (b.kind === "jiraIssue")
    return <JiraIssueApprovalBody body={b} onDecide={onDecide} />;
  if (b.kind === "confluencePage")
    return <ConfluencePageApprovalBody body={b} />;
  if (b.kind === "tempoWorklog") {
    return (
      <ul className="space-y-1">
        {b.items.map((item, i) => (
          <li key={i} className="text-caption">
            <span className="font-mono text-fg">{item.issueKey}</span>
            <span className="text-muted-foreground">
              {" "}
              · {item.date} · {item.duration}
            </span>
            {item.error ? (
              <span className="text-danger"> · {item.error}</span>
            ) : item.resultWorklogId ? (
              <span className="text-green-600 dark:text-green-400">
                {" "}
                · done
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  if (b.kind === "gmailArchive") return <GmailArchiveBody body={b} />;
  if (b.kind === "projectCreate") return <ProjectCreateBody body={b} />;
  if (b.kind === "managedPullRequestMerge")
    return <ManagedMergeBody body={b} />;
  if (b.kind === "settingsInput")
    return <SettingsInputApprovalBody body={b} {...settingsInput} />;
  // commit
  return (
    <>
      <div className="whitespace-pre-wrap text-caption text-fg">
        {b.message}
      </div>
      <div className="text-caption text-faint">
        {b.files.length} file{b.files.length === 1 ? "" : "s"}
        {b.branch ? ` · ${b.branch}` : ""}
        {typeof b.insertions === "number" ? ` · +${b.insertions}` : ""}
        {typeof b.deletions === "number" ? ` · -${b.deletions}` : ""}
      </div>
    </>
  );
}

/** Which button is waiting on the server's echo. */
type BusyDecision = ApprovalDecision | "approvedForSession";

export function ApprovalCard({
  approval,
  onResolve,
  grants,
  onRevokeGrant,
  accountModels,
  onOpenSession,
}: {
  approval: ApprovalCardData;
  onResolve?:
    | ((
        approvalId: string,
        decision: ApprovalDecision,
        edits?: ApprovalResolutionEdits,
        forSession?: boolean,
      ) => void)
    | undefined;
  /** The session's active grants; this card offers Revoke for the ones it made. */
  grants?: readonly ApprovalGrant[] | undefined;
  onRevokeGrant?: ((sessionId: string, key: string) => void) | undefined;
  /** Account/model combinations offered by an editable card's runtime pickers. */
  accountModels?: readonly AccountModelOption[] | undefined;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const [busy, setBusy] = useState<null | BusyDecision>(null);
  // The stored card stays the agent's proposal: adjustments live here until
  // Approve carries them, so a reload shows what was proposed, not a half-edit.
  const [spawnEdits, setSpawnEdits] = useState<SpawnEdits>({});
  // ANY authoritative card echo ends the local spinner, not just one that
  // changed the status. A refused decision — the server rejecting an edit, or
  // finding a model withdrawn while the card waited — re-sends a card that is
  // STILL pending, which is the case the card must recover from immediately:
  // "fix it and approve again" is a designed flow here, and 15 seconds of dead
  // buttons next to the error is not an answer. The reducer only builds a new
  // card object on `approvalUpdate`, so identity is exactly that echo.
  useEffect(() => {
    setBusy(null);
  }, [approval]);
  // Failsafe for a decision that draws no echo at all (a dropped socket).
  useEffect(() => {
    if (!busy) return;
    const timeout = window.setTimeout(() => setBusy(null), 15_000);
    return () => window.clearTimeout(timeout);
  }, [busy]);
  const decide = (decision: BusyDecision) => {
    setBusy(decision);
    if (decision === "rejected") {
      onResolve?.(approval.id, decision);
      return;
    }
    onResolve?.(
      approval.id,
      "approved",
      spawnResolutionEdits(spawnEdits),
      decision === "approvedForSession",
    );
  };
  // The secret travels only in this decision; the card never stores it.
  const submitSettingsInput = (value: string) => {
    setBusy("approved");
    onResolve?.(approval.id, "approved", { kind: "settingsInput", value });
  };
  const operations = approvalGrantKeys(approval.body).map(approvalGrantLabel);
  // Only the grants THIS card created: an operation granted earlier belongs to
  // the card that granted it.
  const ownGrants = approval.grantedForSession
    ? (grants ?? []).filter((grant) => grant.sourceApprovalId === approval.id)
    : [];
  const awaitingUser = approval.status === "pending" && !approval.autoApproved;
  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2.5">
        <HeaderIcon approval={approval} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-caption font-semibold text-fg">
              {approval.title}
            </span>
            <StatusBadge approval={approval} />
            {approval.autoApproved && approval.status !== "pending" && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-micro font-medium text-muted-foreground"
                title="Ran under an Approve-for-session grant"
              >
                <CheckCheck size={9} />
                Auto-approved
              </span>
            )}
          </div>
          {approval.summary && (
            <div className="truncate text-caption text-faint">
              {approval.summary}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2 px-3 py-3 text-caption text-muted-foreground">
        <Body
          approval={approval}
          onDecide={awaitingUser && busy === null ? decide : undefined}
          settingsInput={{
            active: awaitingUser && busy === null,
            busy:
              busy === "approved"
                ? "submit"
                : busy === "rejected"
                  ? "dismiss"
                  : null,
            onSubmit: submitSettingsInput,
            onDismiss: () => decide("rejected"),
          }}
          spawn={{
            editable: awaitingUser,
            models: accountModels ?? [],
            edits: spawnEdits,
            onEdit: (rowId, patch) =>
              setSpawnEdits((current) => ({
                ...current,
                [rowId]: { ...current[rowId], ...patch },
              })),
            ...(onOpenSession !== undefined ? { onOpenSession } : {}),
          }}
        />
        {approval.status === "executed" &&
          (approval.resultUrl || approval.resultSummary) &&
          (approval.resultUrl ? (
            <a
              href={approval.resultUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-caption text-primary hover:underline"
            >
              <ExternalLink size={12} />
              {approval.resultSummary ?? "View result"}
            </a>
          ) : (
            <div className="text-caption text-green-600 dark:text-green-400">
              {approval.resultSummary}
            </div>
          ))}
        {approval.status === "failed" && (
          <ErrorNote message={approval.error ?? "The action failed."} />
        )}
        {approval.status === "superseded" && (
          <div className="text-caption text-faint">
            Replaced by a newer request for the same action; nothing ran.
          </div>
        )}
        {/* A refused auto-approval hands the card back with its reason; an
            executed one whose outcome could not reach the agent says so. */}
        {(approval.status === "pending" || approval.status === "executed") &&
          approval.error && <ErrorNote message={approval.error} />}
      </div>

      {ownGrants.length > 0 && (
        <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-caption text-muted-foreground">
          <CheckCheck size={12} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Approved for this session:{" "}
            {ownGrants.map((grant) => approvalGrantLabel(grant.key)).join(", ")}
          </span>
          {onRevokeGrant && (
            <button
              type="button"
              onClick={() => {
                for (const grant of ownGrants)
                  onRevokeGrant(approval.sessionId, grant.key);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-surface hover:text-fg"
            >
              Revoke
            </button>
          )}
        </div>
      )}

      {awaitingUser && approval.body.kind !== "settingsInput" && (
        <div className="flex items-center justify-end gap-2 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={() => decide("rejected")}
            disabled={busy !== null}
            aria-busy={busy === "rejected" || undefined}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted-foreground hover:bg-surface hover:text-fg disabled:opacity-50"
          >
            {busy === "rejected" ? (
              <Spinner size="sm" />
            ) : (
              <XCircle size={12} />
            )}
            Reject
          </button>
          <button
            type="button"
            onClick={() => decide("approvedForSession")}
            disabled={busy !== null}
            aria-busy={busy === "approvedForSession" || undefined}
            title={`Approve, and run ${operations.join(", ")} without asking for the rest of this session`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-primary/40 bg-raised px-2.5 py-1 text-caption text-primary hover:bg-primary/10 disabled:opacity-50"
          >
            {busy === "approvedForSession" ? (
              <Spinner size="sm" />
            ) : (
              <CheckCheck size={12} />
            )}
            Approve for session
          </button>
          <button
            type="button"
            onClick={() => decide("approved")}
            disabled={busy !== null}
            aria-busy={busy === "approved" || undefined}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1 text-caption font-medium text-white hover:bg-primary/90 disabled:opacity-50"
          >
            {busy === "approved" ? (
              <Spinner size="sm" />
            ) : (
              <CheckCircle2 size={12} />
            )}
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
