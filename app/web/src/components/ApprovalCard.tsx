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
import { runtimeLabel } from "./common/runtimeLabel.ts";
import { createElement, useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  Bot,
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
  type LucideIcon,
} from "lucide-react";
import type {
  AccountModelOption,
  AgentDefinitionApprovalBody,
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
  ManagedCommitOverrideApprovalBody,
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
import {
  CommitFiles,
  commitBlockerItems,
  commitWarningItems,
} from "./CommitCard.tsx";
import { ConfluencePageApprovalBody } from "./ConfluencePageApprovalBody.tsx";
import { JiraIssueApprovalBody } from "./JiraIssueApprovalBody.tsx";
import {
  formatPaObjectLink,
  type PaObjectLinkResolution,
} from "@assistant/shared/objectLinks";
import { Markdown } from "./Markdown.tsx";
import { useMentionedPaObjectReferences } from "./PaObjectLinks.tsx";
import { usePerfRenderCount } from "../lib/perfStats.ts";
import {
  ClippedMarkdown,
  DialogSection,
  ProposalDialog,
  ProposedMarkdown,
  ReadFullButton,
  type ProposalDecide,
} from "./ProposalText.tsx";
import { SettingsInputApprovalBody } from "./SettingsInputApprovalBody.tsx";
import { NoticeList } from "./tools/NoticeList.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppCard, type AppCardTone } from "./common/AppCard.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";

/**
 * The two providers keep separate approval kinds (persisted cards must stay
 * readable), but the fields this card renders are the same on both — so one
 * body renderer serves them.
 */
type PullRequestApprovalBody =
  GithubPullRequestApprovalBody | ForgejoPullRequestApprovalBody;

/**
 * The card's header: its state, said in words and tinted by tone, so the
 * header alone tells whether this still waits on the reader.
 */
function approvalHeader(approval: ApprovalCardData): {
  tone: AppCardTone;
  label: string;
  title?: string;
} {
  const { status } = approval;
  if (status === "pending" && approval.autoApproved)
    return {
      tone: "neutral",
      label: "Queued",
      title: "Approved for this session; runs when the agent's turn ends",
    };
  if (status === "pending")
    return { tone: "warning", label: "Approval needed" };
  if (status === "executing") return { tone: "info", label: "Running" };
  if (status === "executed" && approvalHasWarnings(approval))
    return { tone: "warning", label: "Done with warnings" };
  if (status === "executed") return { tone: "success", label: "Done" };
  if (status === "failed") return { tone: "destructive", label: "Failed" };
  if (status === "superseded")
    return {
      tone: "neutral",
      label: "Superseded",
      title: "A newer request from this session replaced it",
    };
  return { tone: "neutral", label: "Rejected" };
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

const KIND_ICON: Partial<Record<ApprovalCardData["body"]["kind"], LucideIcon>> =
  {
    githubBranchDelete: Trash2,
    commit: GitCommitHorizontal,
    managedPullRequestMerge: GitMerge,
    managedCommitOverride: GitCommitHorizontal,
    sessionSpawn: Sparkles,
    forgejoRelease: Tag,
    gitTag: Tag,
    confluencePage: FileText,
    gmailArchive: Archive,
    projectCreate: FolderPlus,
    agentDefinition: Bot,
    settingsInput: KeyRound,
  };

function headerIcon(body: ApprovalCardData["body"]): LucideIcon {
  if (body.kind === "githubPullRequest" || body.kind === "forgejoPullRequest")
    return body.operation === "comment"
      ? MessageSquare
      : body.operation === "assign"
        ? UserPlus
        : GitPullRequestArrow;
  if (body.kind === "githubIssue")
    return body.operation === "comment"
      ? MessageSquare
      : body.operation === "label"
        ? Tag
        : CircleDot;
  return KIND_ICON[body.kind] ?? SquarePen;
}

/** A labelled line of a proposal: "Label: value". */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>{" "}
      <span className="text-foreground">{children}</span>
    </div>
  );
}

/** A replaced value beside its replacement, the way Jira field edits read. */
function Replaced({ from, to }: { from: string | undefined; to: string }) {
  if (from === undefined || from === to) return <>{to}</>;
  return (
    <>
      <span className="text-muted-foreground line-through">{from || "—"}</span>{" "}
      → {to}
    </>
  );
}

function PullRequestBody({
  body,
  onDecide,
}: {
  body: PullRequestApprovalBody;
  onDecide: ProposalDecide;
}) {
  const target = `${body.repo}#${body.pullNumber}`;
  if (body.operation === "create") {
    return (
      <>
        {body.title && <Fact label="Title">{body.title}</Fact>}
        <Fact label="Merge">
          <span className="font-mono">{body.head}</span> →{" "}
          <span className="font-mono">{body.base}</span>
          {body.draft ? " · draft" : ""}
        </Fact>
        <ProposedMarkdown
          text={body.prBody ?? ""}
          title={body.title ?? `New pull request in ${body.repo}`}
          readLabel="Read full description"
          empty="No description."
          onDecide={onDecide}
        />
      </>
    );
  }
  if (body.operation === "ready") {
    return (
      <p className="text-foreground">
        Mark pull request #{body.pullNumber} ready for review. This does not
        merge it.
      </p>
    );
  }
  if (body.operation === "edit") {
    return (
      <>
        {body.base && (
          <Fact label={`Retarget #${body.pullNumber} onto`}>
            <span className="font-mono">{body.base}</span>
          </Fact>
        )}
        {body.prBody !== undefined && (
          <ProposedMarkdown
            text={body.prBody}
            previous={body.previousPrBody}
            title={`New description for ${target}`}
            readLabel="Read full description"
            empty="Clears the description."
            onDecide={onDecide}
          />
        )}
      </>
    );
  }
  if (body.operation === "review")
    return <ReviewBody body={body} target={target} onDecide={onDecide} />;
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
          <Fact key={row.label} label={row.label}>
            <span className="font-mono">{row.people.join(", ")}</span>
          </Fact>
        ))}
      </>
    );
  }
  return body.commentBody ? (
    <ProposedMarkdown
      text={body.commentBody}
      title={`Comment on ${target}`}
      readLabel="Read full comment"
      onDecide={onDecide}
    />
  ) : null;
}

/** How many inline comments the card lists; its dialog has all of them. */
const CARD_INLINE_COMMENTS = 8;

function InlineComments({
  comments,
}: {
  comments: NonNullable<PullRequestApprovalBody["inlineComments"]>;
}) {
  return (
    <ItemGroup className="gap-1">
      {comments.map((c, i) => (
        <Item key={i} variant="muted" size="xs">
          <ItemContent>
            <ItemDescription className="font-mono">
              {c.path}:{c.line}
            </ItemDescription>
            <div className="min-w-0 text-foreground">
              <Markdown text={c.body} density="compact" />
            </div>
            {c.suggestion && (
              <pre className="overflow-x-auto rounded-md bg-background p-1.5 text-xs text-foreground">
                <code>{c.suggestion}</code>
              </pre>
            )}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}

/**
 * A review is approved whole, summary and every inline comment, so "Read full
 * review" opens all of it — the card lists only the first few comments.
 */
function ReviewBody({
  body,
  target,
  onDecide,
}: {
  body: PullRequestApprovalBody;
  target: string;
  onDecide: ProposalDecide;
}) {
  const [open, setOpen] = useState(false);
  const comments = body.inlineComments ?? [];
  const hidden = comments.length - CARD_INLINE_COMMENTS;
  const commentsLabel = `${comments.length} inline comment${comments.length === 1 ? "" : "s"}`;
  return (
    <div className="flex flex-col items-start gap-2">
      {body.reviewSummary ? (
        <ClippedMarkdown text={body.reviewSummary} />
      ) : null}
      {comments.length > 0 ? (
        <div className="flex w-full flex-col gap-1">
          <p>{commentsLabel}:</p>
          <InlineComments comments={comments.slice(0, CARD_INLINE_COMMENTS)} />
          {hidden > 0 ? <p>and {hidden} more</p> : null}
        </div>
      ) : null}
      {body.reviewSummary || comments.length > 0 ? (
        <ReadFullButton
          label="Read full review"
          onClick={() => setOpen(true)}
        />
      ) : null}
      <ProposalDialog
        open={open}
        title={`Review of ${target}`}
        onOpenChange={setOpen}
        onDecide={onDecide}
      >
        {body.reviewSummary ? (
          <DialogSection title="Summary">
            <Markdown text={body.reviewSummary} />
          </DialogSection>
        ) : null}
        {comments.length > 0 ? (
          <DialogSection title={commentsLabel}>
            <InlineComments comments={comments} />
          </DialogSection>
        ) : null}
      </ProposalDialog>
    </div>
  );
}

function GithubIssueBody({
  body,
  onDecide,
}: {
  body: GithubIssueApprovalBody;
  onDecide: ProposalDecide;
}) {
  const target = `${body.repo}#${body.number}`;
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "Title",
      value: body.title ? (
        <Replaced from={body.previousTitle} to={body.title} />
      ) : (
        ""
      ),
    },
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
  return (
    <>
      {rows.map((row) => (
        <Fact key={row.label} label={row.label}>
          {row.value}
        </Fact>
      ))}
      {body.operation === "comment" && body.commentBody !== undefined ? (
        <ProposedMarkdown
          text={body.commentBody}
          title={`Comment on ${target}`}
          readLabel="Read full comment"
          onDecide={onDecide}
        />
      ) : body.issueBody !== undefined ? (
        <ProposedMarkdown
          text={body.issueBody}
          previous={body.previousIssueBody}
          title={
            body.operation === "create"
              ? (body.title ?? `New issue in ${body.repo}`)
              : `New description for ${target}`
          }
          readLabel="Read full description"
          empty={
            body.operation === "create"
              ? "No description."
              : "Clears the description."
          }
          onDecide={onDecide}
        />
      ) : null}
      {body.newLabels?.length ? (
        <Alert variant="warning" role="note">
          <AlertTriangle />
          <AlertDescription>
            Not yet in {body.repo}, GitHub will create:{" "}
            {body.newLabels.join(", ")}
          </AlertDescription>
        </Alert>
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
    <ul className="flex flex-col gap-1.5">
      {body.items.map((item) => (
        <li key={item.branch} className="flex flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="size-3 shrink-0" />
            <span className="font-mono break-all text-foreground">
              {item.branch}
            </span>
            <span className="font-mono text-xs">
              {item.headSha.slice(0, 7)}
            </span>
            {item.deleted ? <Badge variant="success">deleted</Badge> : null}
          </div>
          {item.error ? (
            <p className="pl-4 break-words text-destructive">{item.error}</p>
          ) : null}
          {item.openPullRequests?.map((pull) => (
            <p
              key={`${pull.role}-${pull.number}`}
              className="flex items-start gap-1.5 pl-4 text-warning"
            >
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <a
                href={pull.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 break-words underline underline-offset-2"
              >
                #{pull.number} {pull.title}
              </a>
              <span className="shrink-0 text-muted-foreground">
                ({pull.role === "head" ? "its head" : "its base"}; will close)
              </span>
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function GitTagBody({ body }: { body: GitTagApprovalBody }) {
  return (
    <>
      <Fact label="Tag">
        <span className="font-mono">{body.tag}</span> at{" "}
        <span className="font-mono break-all">{body.targetSha}</span>
      </Fact>
      <Fact label="Checkout">
        <span className="font-mono break-all">{body.repoPath}</span>
      </Fact>
      <Fact label="Push to">
        <span className="font-mono">
          {body.remote}/{body.branch}
        </span>
      </Fact>
      <Fact label="Destination">
        <span className="font-mono break-all">{body.pushUrlDisplay}</span>
      </Fact>
    </>
  );
}

function ReleaseBody({
  body,
  onDecide,
}: {
  body: ForgejoReleaseApprovalBody;
  onDecide: ProposalDecide;
}) {
  return (
    <>
      <Fact label="Tag">
        <span className="font-mono">{body.tag}</span>
        {body.draft ? " · draft" : ""}
        {body.prerelease ? " · prerelease" : ""}
      </Fact>
      <Fact label="At">
        <span className="font-mono">{body.targetSha.slice(0, 8)}</span>
        {body.targetRef ? (
          <span className="text-muted-foreground"> ({body.targetRef})</span>
        ) : null}
      </Fact>
      {body.targetSubject ? <p>{body.targetSubject}</p> : null}
      {body.notes && (
        <ProposedMarkdown
          text={body.notes}
          title={`Release notes for ${body.name || body.tag}`}
          readLabel="Read full notes"
          onDecide={onDecide}
        />
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
      <Fact label="Merge">
        <span className="font-mono">{body.headBranch}</span> →{" "}
        <span className="font-mono">{body.baseBranch}</span>{" "}
        <span className="text-muted-foreground">(default branch)</span>
      </Fact>
      <p>
        {body.repo}#{body.number} · {body.method} ·{" "}
        {body.deleteRemoteBranch
          ? "delete the remote branch"
          : "keep the remote branch"}
      </p>
      <p>
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
      </p>
      <p>
        Repository allows: {body.supportedMethods.join(", ") || "no method"}
      </p>
      {body.linkedTask ? (
        <p>
          Task-{body.linkedTask.id}: {body.linkedTask.title}
        </p>
      ) : null}
    </>
  );
}

/**
 * An agent asking to commit past the commit review that blocked it. The card
 * says plainly that approving overrides the review, then shows everything the
 * user is overriding: every blocker, the agent's reason, the branch and scope,
 * and the exact message and files. Approving re-runs the review server-side and
 * still refuses secrets and conflicts, so the card states what was found rather
 * than promising the commit will land.
 */
function ManagedCommitOverrideBody({
  body,
}: {
  body: ManagedCommitOverrideApprovalBody;
}) {
  const { commit } = body;
  const files = commit.totals.files;
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="warning" role="note">
        <AlertTriangle />
        <AlertDescription>
          The commit review blocked this commit. Approving overrides the review
          once and commits exactly the message and files below. A fresh secret
          or conflict still stops it.
        </AlertDescription>
      </Alert>
      <NoticeList
        variant="destructive"
        title="Review blockers"
        items={commitBlockerItems(commit.blockers)}
      />
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Agent's reason
        </p>
        <div className="min-w-0 text-foreground">
          <Markdown text={body.reason} density="compact" />
        </div>
      </div>
      <div>
        <Fact label="Branch">
          <span className="font-mono">{body.branch}</span>
        </Fact>
        <Fact label="Scope">
          {body.stagedOnly ? "staged changes only" : "all changes"} · {files}{" "}
          file{files === 1 ? "" : "s"} ·{" "}
          <span className="text-success">+{commit.totals.additions}</span>{" "}
          <span className="text-destructive">-{commit.totals.deletions}</span>
        </Fact>
      </div>
      {commit.commitMessage ? (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            Commit message
          </p>
          <pre className="rounded-lg border bg-muted p-2 font-mono text-sm wrap-anywhere whitespace-pre-wrap text-foreground">
            {commit.commitMessage}
          </pre>
        </div>
      ) : null}
      <CommitFiles files={commit.files} />
      <NoticeList
        title="Warnings"
        items={commitWarningItems(commit.warnings)}
      />
    </div>
  );
}

/** One row's pending changes; absent fields keep what the agent proposed. */
interface SpawnRowEdit {
  skip?: boolean;
  owner?: "coordinator" | "user";
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
    ...(edit.owner ? { owner: edit.owner } : {}),
  }));
  return items.length > 0 ? { kind: "sessionSpawn", items } : undefined;
}

/** Where the session will run, as one readable line. */
function spawnTargetLine(item: SessionSpawnApprovalItem): string {
  const persona = item.agentType === "developer" ? "Developer" : "Assistant";
  return [
    item.agent ? `Agent ${item.agent} (${persona})` : persona,
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
  requiresEnterprise,
  editable,
  models,
  edit,
  onEdit,
  onOpenSession,
}: {
  item: SessionSpawnApprovalItem;
  /** The source's or the row's sealed requirement; the server enforces it. */
  requiresEnterprise: boolean;
  editable: boolean;
  models: readonly AccountModelOption[];
  edit: SpawnRowEdit | undefined;
  onEdit: (patch: SpawnRowEdit) => void;
  onOpenSession?: ((id: string) => void) | undefined;
}) {
  const [showPrompt, setShowPrompt] = useState(false);
  const skipped = edit?.skip ?? item.skipped ?? false;
  const owner = edit?.owner ?? item.owner ?? "coordinator";
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
    <Item
      variant="outline"
      size="sm"
      className={`items-start ${skipped ? "opacity-50" : ""}`}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">
            <Markdown text={item.title} inline />
          </span>
        </ItemTitle>
        <ItemDescription className="truncate">
          {spawnTargetLine(item)}
        </ItemDescription>
      </ItemContent>
      {editable && (
        <ItemActions>
          <Button
            variant="outline"
            size="xs"
            onClick={() => onEdit({ skip: !skipped })}
          >
            {skipped ? "Include" : "Skip"}
          </Button>
        </ItemActions>
      )}
      <div className="flex basis-full flex-col items-start gap-1">
        {editable && !skipped ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={owner}
              onValueChange={(value) => {
                if (value === "coordinator" || value === "user")
                  onEdit({ owner: value });
              }}
            >
              <SelectTrigger size="xs" aria-label={`Owner of ${item.title}`}>
                <SelectValue>
                  {owner === "user" ? "User-owned" : "Coordinator-owned"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coordinator">Coordinator-owned</SelectItem>
                <SelectItem value="user">User-owned</SelectItem>
              </SelectContent>
            </Select>
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
          <p className="text-muted-foreground">
            {runtimeLabel({
              model: selected?.name ?? item.modelName ?? item.modelId,
              thinkingLevel,
              account: selected?.accountName ?? item.accountName,
            })}
          </p>
        )}
        <p className="text-muted-foreground">
          {owner === "user"
            ? "User's inbox · No report owed"
            : "Coordinator's helpers"}
        </p>
        {requiresEnterprise && (
          <p className="text-muted-foreground">Requires enterprise</p>
        )}
        {item.responseRequestWithdrawn && (
          <p className="text-muted-foreground">Awaited reply withdrawn</p>
        )}
        {item.inheritGrants === false && (
          <p className="text-muted-foreground">
            Won&rsquo;t inherit your approvals
          </p>
        )}
        {warning && (
          <p className="flex items-start gap-1.5 text-warning">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>{warning}</span>
          </p>
        )}
        <Collapsible
          open={showPrompt}
          onOpenChange={setShowPrompt}
          className="w-full"
        >
          <CollapsibleTrigger
            render={<Button variant="link" size="xs" className="px-0" />}
          >
            {showPrompt ? "Hide opening message" : "more…"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="min-w-0 rounded-md bg-muted p-2 text-foreground">
              <Markdown text={item.prompt} density="compact" />
            </div>
          </CollapsibleContent>
        </Collapsible>
        {item.resultSessionId && (
          <LinkButton
            variant="link"
            size="xs"
            className="px-0"
            href={sessionPath(item.resultSessionId)}
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
          </LinkButton>
        )}
        {item.error && <ErrorNote message={item.error} />}
      </div>
    </Item>
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
    <ItemGroup className="gap-2">
      {body.items.map((item) => (
        <SpawnRow
          key={item.rowId}
          item={item}
          requiresEnterprise={
            body.requiresEnterprise === true || item.requiresEnterprise === true
          }
          editable={editable}
          models={models}
          edit={edits[item.rowId]}
          onEdit={(patch) => onEdit(item.rowId, patch)}
          onOpenSession={onOpenSession}
        />
      ))}
    </ItemGroup>
  );
}

/** A label column beside a value, for bodies that list several facts per row. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
  );
}

/** A before → after pair, or just the value when nothing was there before. */
function Change({
  before,
  after,
}: {
  before?: string | undefined;
  after: string;
}) {
  return before !== undefined && before !== after ? (
    <>
      <span className="text-muted-foreground line-through">{before}</span> →{" "}
      {after}
    </>
  ) : (
    <>{after}</>
  );
}

function AgentDefinitionBody({ body }: { body: AgentDefinitionApprovalBody }) {
  const effort = (level: ThinkingLevel | undefined) => level ?? "default";
  return (
    <>
      <Row label="Agent">
        <span className="font-mono">{body.name}</span>{" "}
        <span className="text-muted-foreground">
          · <Change before={body.personaBefore} after={body.persona} />
        </span>
      </Row>
      <Row label="Models">
        <Change
          before={body.model.before?.join(", ")}
          after={body.model.after.join(", ")}
        />
        {body.resolvedModels.map((resolved, at) => (
          <span key={at} className="block font-mono text-muted-foreground">
            {resolved.model} at {resolved.effort}
            {at === 0 ? " (default)" : ""}
          </span>
        ))}
      </Row>
      <Row label="Effort">
        <Change
          {...(body.action === "edit"
            ? { before: effort(body.effort.before) }
            : {})}
          after={effort(body.effort.after)}
        />
      </Row>
      <Row label="Purpose">
        <Markdown text={body.description} inline />
      </Row>
      {body.resultCommit ? (
        <Row label="Commit">
          <span className="font-mono">{body.resultCommit}</span>
        </Row>
      ) : null}
      <pre className="max-h-80 overflow-auto rounded-md bg-background p-1.5 text-xs text-foreground">
        <code>{body.source}</code>
      </pre>
    </>
  );
}

function GmailArchiveBody({ body }: { body: GmailArchiveApprovalBody }) {
  return (
    <div
      className="max-h-80 overflow-y-auto overscroll-contain rounded-lg border"
      role="region"
      tabIndex={0}
      aria-label={`${body.items.length} emails to archive`}
    >
      <ul className="divide-y">
        {body.items.map((item) => (
          <li key={item.messageId} className="flex flex-col gap-1 px-2.5 py-2">
            <Row label="From">{item.sender}</Row>
            <Row label="Subject">
              <a
                href={item.gmailUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {item.subject}
              </a>
            </Row>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What approval will bring into existence, and after it runs, what did. */
function ProjectCreateBody({ body }: { body: ProjectCreateApprovalBody }) {
  const { project, repository } = body;
  return (
    <>
      <Row label="Project">
        {project.name}{" "}
        <span className="font-mono text-muted-foreground">
          {project.key} · {project.id}
        </span>
      </Row>
      {project.parentId ? (
        <Row label="Parent">
          <span className="font-mono">{project.parentId}</span>
        </Row>
      ) : null}
      {project.tags?.length ? (
        <Row label="Tags">{project.tags.join(", ")}</Row>
      ) : null}
      {project.jira?.length ? (
        <Row label="Jira">
          <span className="font-mono">
            {project.jira
              .map((link) => link.issueKey ?? link.projectKey)
              .filter(Boolean)
              .join(", ")}
          </span>
        </Row>
      ) : null}
      {repository?.mode === "create" ? (
        <Row label="Repository">
          New {repository.private ? "private" : "public"}{" "}
          {repository.provider === "github" ? "GitHub" : "Forgejo"} repository{" "}
          <span className="font-mono">
            {repository.owner}/{repository.name}
          </span>
          , initialized with a README
        </Row>
      ) : repository?.mode === "link" ? (
        <Row label="Repository">
          <span className="font-mono break-all">{repository.url}</span>
          {repository.seedReadme ? (
            <span className="text-muted-foreground">
              {" "}
              · empty, a README commit is added
            </span>
          ) : null}
        </Row>
      ) : null}
      {repository?.mode === "create" && body.resultRepoUrl ? (
        <Row label="Created">
          {body.resultWebUrl ? (
            <a
              href={body.resultWebUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono break-all underline underline-offset-2"
            >
              {body.resultRepoUrl}
            </a>
          ) : (
            <span className="font-mono break-all">{body.resultRepoUrl}</span>
          )}
        </Row>
      ) : null}
      {body.cloneDir ? (
        <Row label="Clone into">
          <span className="font-mono break-all">{body.cloneDir}</span>
        </Row>
      ) : null}
      {project.description ? (
        <ClippedMarkdown text={project.description} />
      ) : null}
    </>
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
    return <PullRequestBody body={b} onDecide={onDecide} />;
  if (b.kind === "githubIssue")
    return <GithubIssueBody body={b} onDecide={onDecide} />;
  if (b.kind === "githubBranchDelete")
    return <GithubBranchDeleteBody body={b} />;
  if (b.kind === "forgejoRelease")
    return <ReleaseBody body={b} onDecide={onDecide} />;
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
    return <ConfluencePageApprovalBody body={b} onDecide={onDecide} />;
  if (b.kind === "tempoWorklog") {
    return (
      <ul className="flex flex-col gap-1">
        {b.items.map((item, i) => (
          <li key={i}>
            <span className="font-mono text-foreground">{item.issueKey}</span>
            <span className="text-muted-foreground">
              {" "}
              · {item.date} · {item.duration}
            </span>
            {item.error ? (
              <span className="text-destructive"> · {item.error}</span>
            ) : item.resultWorklogId ? (
              <span className="text-success"> · done</span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  if (b.kind === "gmailArchive") return <GmailArchiveBody body={b} />;
  if (b.kind === "projectCreate") return <ProjectCreateBody body={b} />;
  if (b.kind === "agentDefinition") return <AgentDefinitionBody body={b} />;
  if (b.kind === "managedPullRequestMerge")
    return <ManagedMergeBody body={b} />;
  if (b.kind === "managedCommitOverride")
    return <ManagedCommitOverrideBody body={b} />;
  if (b.kind === "settingsInput")
    return <SettingsInputApprovalBody body={b} {...settingsInput} />;
  // commit
  return (
    <>
      <p className="whitespace-pre-wrap text-foreground">{b.message}</p>
      <p>
        {b.files.length} file{b.files.length === 1 ? "" : "s"}
        {b.branch ? ` · ${b.branch}` : ""}
        {typeof b.insertions === "number" ? ` · +${b.insertions}` : ""}
        {typeof b.deletions === "number" ? ` · -${b.deletions}` : ""}
      </p>
    </>
  );
}

// Shared, so a render without a link source hands Markdown the same array.
const NO_PA_REFERENCES: PaObjectLinkResolution[] = [];

/**
 * The audit line of a card an ancestor's grant covered: which session's grant
 * it ran under, for which operations. Each holder is a `pa://` session link,
 * so it reads as that session's title.
 */
function InheritedGrantsNote({
  grants,
}: {
  grants: NonNullable<ApprovalCardData["inheritedGrants"]>;
}) {
  const byHolder = new Map<string, string[]>();
  for (const grant of grants)
    byHolder.set(grant.fromSessionId, [
      ...(byHolder.get(grant.fromSessionId) ?? []),
      approvalGrantLabel(grant.key),
    ]);
  const text = [...byHolder]
    .map(
      ([holder, labels]) =>
        `Covered by [](${formatPaObjectLink({ objectType: "session", id: holder })})’s grant: ${labels.join(", ")}`,
    )
    .join("; ");
  const linked = useMentionedPaObjectReferences(text);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <CheckCheck className="size-3 shrink-0" />
      <span className="min-w-0 truncate">
        <Markdown
          text={text}
          inline
          paObjectReferences={linked.references ?? NO_PA_REFERENCES}
          onOpenPaObject={linked.onOpen}
        />
      </span>
    </span>
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
  usePerfRenderCount("ApprovalCard");
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
  const header = approvalHeader(approval);
  const showDecision = awaitingUser && approval.body.kind !== "settingsInput";
  // A card with no grantable operation (a commit review override) is decided
  // one card at a time: there is nothing a session grant could cover.
  const grantable = operations.length > 0;
  return (
    <AppCard
      tone={header.tone}
      icon={createElement(headerIcon(approval.body))}
      label={<span title={header.title}>{header.label}</span>}
      status={
        approval.status === "executing" ? (
          <Spinner size="sm" />
        ) : approval.autoApproved && approval.status !== "pending" ? (
          <span
            className="inline-flex items-center gap-1"
            title="Ran under an Approve-for-session grant"
          >
            <CheckCheck />
            Auto-approved
          </span>
        ) : null
      }
      footerStart={
        ownGrants.length > 0 ? (
          <span className="inline-flex items-center gap-1">
            <CheckCheck className="size-3 shrink-0" />
            Approved for this session:{" "}
            {ownGrants.map((grant) => approvalGrantLabel(grant.key)).join(", ")}
          </span>
        ) : approval.inheritedGrants?.length ? (
          <InheritedGrantsNote grants={approval.inheritedGrants} />
        ) : null
      }
      actions={
        <>
          {ownGrants.length > 0 && onRevokeGrant ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                for (const grant of ownGrants)
                  onRevokeGrant(approval.sessionId, grant.key);
              }}
            >
              Revoke
            </Button>
          ) : null}
          {showDecision ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => decide("rejected")}
                disabled={busy !== null}
                busy={busy === "rejected"}
              >
                Reject
              </Button>
              {grantable ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => decide("approvedForSession")}
                  disabled={busy !== null}
                  busy={busy === "approvedForSession"}
                  title={`Approve, and run ${operations.join(", ")} without asking for the rest of this session`}
                >
                  Approve for session
                </Button>
              ) : null}
              <Button
                size="xs"
                onClick={() => decide("approved")}
                disabled={busy !== null}
                busy={busy === "approved"}
              >
                Approve
              </Button>
            </>
          ) : null}
        </>
      }
      contentClassName="text-muted-foreground"
    >
      {/* The subject leads the content; the header says only its state. */}
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="font-medium text-foreground">{approval.title}</p>
        {approval.summary ? (
          <p className="truncate">{approval.summary}</p>
        ) : null}
      </div>
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
          <LinkButton
            variant="link"
            size="sm"
            className="self-start px-0"
            href={approval.resultUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink />
            {approval.resultSummary ?? "View result"}
          </LinkButton>
        ) : (
          <p className="text-success">{approval.resultSummary}</p>
        ))}
      {approval.status === "failed" && (
        <ErrorNote message={approval.error ?? "The action failed."} />
      )}
      {approval.status === "superseded" && (
        <p>Replaced by a newer request for the same action; nothing ran.</p>
      )}
      {/* A refused auto-approval hands the card back with its reason; an
            executed one whose outcome could not reach the agent says so. */}
      {(approval.status === "pending" || approval.status === "executed") &&
        approval.error && <ErrorNote message={approval.error} />}
    </AppCard>
  );
}
