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
import { createElement, useEffect, useState, type ReactNode } from "react";
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
  type LucideIcon,
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
import { LinkButton } from "./common/LinkButton.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

function StatusBadge({ approval }: { approval: ApprovalCardData }) {
  const { status } = approval;
  if (status === "pending" && approval.autoApproved)
    return (
      <Badge
        variant="secondary"
        title="Approved for this session; runs when the agent's turn ends"
      >
        Queued
      </Badge>
    );
  if (status === "pending")
    return <Badge variant="warning">Pending approval</Badge>;
  if (status === "executing")
    return (
      <Badge variant="secondary">
        <Spinner size="sm" />
        Executing
      </Badge>
    );
  if (status === "executed" && approvalHasWarnings(approval))
    return (
      <Badge variant="warning">
        <CheckCircle2 />
        Done with warnings
      </Badge>
    );
  if (status === "executed")
    return (
      <Badge variant="success">
        <CheckCircle2 />
        Done
      </Badge>
    );
  if (status === "failed")
    return (
      <Badge variant="destructive">
        <XCircle />
        Failed
      </Badge>
    );
  if (status === "superseded")
    return (
      <Badge
        variant="outline"
        title="A newer request from this session replaced it"
      >
        Superseded
      </Badge>
    );
  return <Badge variant="outline">Rejected</Badge>;
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
    sessionSpawn: Sparkles,
    forgejoRelease: Tag,
    gitTag: Tag,
    confluencePage: FileText,
    gmailArchive: Archive,
    projectCreate: FolderPlus,
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

const CLAMPED = "line-clamp-6 whitespace-pre-wrap";

function PullRequestBody({ body }: { body: PullRequestApprovalBody }) {
  if (body.operation === "create") {
    return (
      <>
        {body.title && <Fact label="Title">{body.title}</Fact>}
        <Fact label="Merge">
          <span className="font-mono">{body.head}</span> →{" "}
          <span className="font-mono">{body.base}</span>
          {body.draft ? " · draft" : ""}
        </Fact>
        {body.prBody && (
          <p className="line-clamp-4 whitespace-pre-wrap">{body.prBody}</p>
        )}
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
        <p>Replace description on #{body.pullNumber} with:</p>
        <p className={CLAMPED}>
          {body.prBody === "" ? "(empty description)" : body.prBody}
        </p>
      </>
    );
  }
  if (body.operation === "review") {
    return (
      <>
        {body.reviewSummary && <p className={CLAMPED}>{body.reviewSummary}</p>}
        {body.inlineComments && body.inlineComments.length > 0 && (
          <>
            <p>
              {body.inlineComments.length} inline comment
              {body.inlineComments.length === 1 ? "" : "s"}:
            </p>
            <ItemGroup className="gap-1">
              {body.inlineComments.slice(0, 8).map((c, i) => (
                <Item key={i} variant="muted" size="xs">
                  <ItemContent>
                    <ItemDescription className="font-mono">
                      {c.path}:{c.line}
                    </ItemDescription>
                    <p className="text-foreground">{c.body}</p>
                    {c.suggestion && (
                      <pre className="overflow-x-auto rounded-md bg-background p-1.5 text-xs text-foreground">
                        <code>{c.suggestion}</code>
                      </pre>
                    )}
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </>
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
          <Fact key={row.label} label={row.label}>
            <span className="font-mono">{row.people.join(", ")}</span>
          </Fact>
        ))}
      </>
    );
  }
  return body.commentBody ? (
    <p className={CLAMPED}>{body.commentBody}</p>
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
        <Fact key={row.label} label={row.label}>
          {row.value}
        </Fact>
      ))}
      {text !== undefined && (
        <>
          {body.operation === "edit" && <p>Replace description with:</p>}
          <p className={CLAMPED}>{text}</p>
        </>
      )}
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

function ReleaseBody({ body }: { body: ForgejoReleaseApprovalBody }) {
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
      {body.notes && <p className={CLAMPED}>{body.notes}</p>}
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
    <Item
      variant="outline"
      size="sm"
      className={`items-start ${skipped ? "opacity-50" : ""}`}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <span className="truncate">{item.title}</span>
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
            {[
              selected?.name ?? item.modelName ?? item.modelId,
              selected?.accountName ?? item.accountName,
              `${thinkingLevel} thinking`,
            ]
              .filter(Boolean)
              .join(" · ")}
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
            <p className="rounded-md bg-muted p-2 whitespace-pre-wrap text-foreground">
              {item.prompt}
            </p>
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
        <p className={CLAMPED}>{project.description}</p>
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
  if (b.kind === "managedPullRequestMerge")
    return <ManagedMergeBody body={b} />;
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
    <Card size="sm" className="my-2">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          {createElement(headerIcon(approval.body), {
            className: "size-4 shrink-0 text-primary",
          })}
          <span className="truncate">{approval.title}</span>
          <StatusBadge approval={approval} />
          {approval.autoApproved && approval.status !== "pending" && (
            <Badge
              variant="outline"
              title="Ran under an Approve-for-session grant"
            >
              <CheckCheck />
              Auto-approved
            </Badge>
          )}
        </CardTitle>
        {approval.summary && (
          <CardDescription className="truncate">
            {approval.summary}
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-2 text-muted-foreground">
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
      </CardContent>

      {(ownGrants.length > 0 ||
        (awaitingUser && approval.body.kind !== "settingsInput")) && (
        <CardFooter className="flex-col items-stretch gap-2">
          {ownGrants.length > 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <CheckCheck className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                Approved for this session:{" "}
                {ownGrants
                  .map((grant) => approvalGrantLabel(grant.key))
                  .join(", ")}
              </span>
              {onRevokeGrant && (
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
              )}
            </div>
          )}
          {awaitingUser && approval.body.kind !== "settingsInput" && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => decide("rejected")}
                disabled={busy !== null}
                busy={busy === "rejected"}
              >
                {busy === "rejected" ? null : <XCircle />}
                Reject
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => decide("approvedForSession")}
                disabled={busy !== null}
                busy={busy === "approvedForSession"}
                title={`Approve, and run ${operations.join(", ")} without asking for the rest of this session`}
              >
                {busy === "approvedForSession" ? null : <CheckCheck />}
                Approve for session
              </Button>
              <Button
                size="sm"
                onClick={() => decide("approved")}
                disabled={busy !== null}
                busy={busy === "approved"}
              >
                {busy === "approved" ? null : <CheckCircle2 />}
                Approve
              </Button>
            </div>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
