/**
 * @widget JiraIssueApprovalBody
 * @purpose The Jira detail of `ApprovalCard`: the creates, comments and edits a
 *   `jira_mutate_issue` proposal carries. Markdown bodies render as Jira will
 *   show them (the server converts the same source to ADF on execution), the
 *   card clips a long description to a preview, and "Read full ticket" opens the
 *   whole proposal in a modal with the same Approve/Reject as the card. A
 *   sprint edit shows each changed property, dates in the viewer's local time.
 * @payload `JiraIssueApprovalBody` (`ApprovalCard.body`).
 * @useWhen Rendered by `ApprovalCard` for `body.kind === "jiraIssue"`.
 */
import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type {
  JiraIssueApprovalBody as JiraIssueApprovalBodyData,
  JiraIssueMutationItemDisplay,
  JiraSprintChangeDisplay,
} from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import {
  ClippedMarkdown,
  DialogSection,
  ProposalDialog,
  ReadFullButton,
  type ProposalDecide,
} from "./ProposalText.tsx";
import { Badge } from "@/components/ui/badge";
import { formatPropertyDate, parsePropertyDate } from "../lib/propertyDates.ts";

type JiraItem = JiraIssueMutationItemDisplay;

export function JiraIssueApprovalBody({
  body,
  onDecide,
}: {
  body: JiraIssueApprovalBodyData;
  onDecide: ProposalDecide;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {body.items.map((item, i) => (
        <li key={item.clientId || i}>
          {item.operation === "create" ? (
            <CreateItem item={item} onDecide={onDecide} />
          ) : item.operation === "comment" ? (
            <CommentItem item={item} onDecide={onDecide} />
          ) : item.operation === "rank" ? (
            <RankItem item={item} />
          ) : item.operation === "sprint" ? (
            <SprintItem item={item} />
          ) : (
            <EditItem item={item} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** What succeeded, named by the operation: a comment or edit is not a creation. */
function outcomeLabel(item: JiraItem): string {
  if (item.operation === "create")
    return `created${item.resultIssueKey ? ` ${item.resultIssueKey}` : ""}`;
  if (item.operation === "comment") return "commented";
  if (item.operation === "rank") return "reordered";
  if (item.operation === "sprint") return "sprint updated";
  return "updated";
}

function Outcome({ item }: { item: JiraItem }) {
  return (
    <MutationOutcome
      error={item.error}
      warning={item.warning}
      url={item.resultIssueUrl}
      done={Boolean(item.resultIssueUrl)}
      label={outcomeLabel(item)}
    />
  );
}

/** One proposed write's result: its error, or what it did (linked), plus any warning. */
export function MutationOutcome({
  error,
  warning,
  url,
  done,
  label,
}: {
  error?: string | null | undefined;
  warning?: string | null | undefined;
  url?: string | null | undefined;
  done: boolean;
  label: string;
}) {
  if (!error && !done && !warning) return null;
  return (
    <div className="flex flex-col items-start gap-0.5">
      {error ? (
        <p className="text-destructive">{error}</p>
      ) : url ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-success hover:underline"
        >
          <ExternalLink className="size-3" />
          {label}
        </a>
      ) : done ? (
        <p className="text-success">{label}</p>
      ) : null}
      {warning ? <p className="text-warning">{warning}</p> : null}
    </div>
  );
}

/** `Project · Type` in the chip every create wears, in card and modal. */
function IssueKind({ item }: { item: JiraItem }) {
  return (
    <Badge variant="secondary" className="font-mono">
      {item.createProjectKey} · {item.createIssueType}
    </Badge>
  );
}

/** How an absent value reads: the write still happens, so the row still shows. */
const EMPTY_VALUE = "—";

/**
 * Everything a create sets besides summary and description: the parent and
 * every known or advanced field the agent asked for. Shown as `Label: value`,
 * the way Jira's own sidebar states them. A null or empty value is a write
 * too (`parentIssue: null`, an advanced field cleared), so it keeps its row.
 */
function createFields(item: JiraItem): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (item.createParentIssue)
    rows.push({ label: "Parent", value: item.createParentIssue });
  for (const change of item.fieldChanges) {
    if (change.fieldId === "parent" && item.createParentIssue) continue;
    rows.push({ label: change.label, value: change.to || EMPTY_VALUE });
  }
  return rows;
}

function FieldRows({
  rows,
  className,
}: {
  rows: Array<{ label: string; value: string }>;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <dl className={className}>
      {rows.map((row) => (
        <div key={`${row.label}:${row.value}`} className="flex gap-1.5">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LinkRows({ item }: { item: JiraItem }) {
  if (!item.linkChanges?.length) return null;
  return (
    <ul className="space-y-0.5">
      {item.linkChanges.map((link, i) => (
        <li key={i} className="text-sm text-muted-foreground">
          {link.op === "remove" ? "unlink" : link.relationship}{" "}
          <span className="font-mono text-foreground">
            {link.targetIssueKey || link.linkId}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CreateItem({
  item,
  onDecide,
}: {
  item: JiraItem;
  onDecide: ProposalDecide;
}) {
  const [open, setOpen] = useState(false);
  const fields = createFields(item);
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <IssueKind item={item} />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          {item.createSummary}
        </span>
      </div>
      <FieldRows rows={fields} className="flex flex-wrap gap-x-4 gap-y-0.5" />
      {item.createDescription ? (
        <ClippedMarkdown text={item.createDescription} />
      ) : (
        <div className="text-muted-foreground">No description.</div>
      )}
      <LinkRows item={item} />
      <ReadFullButton label="Read full ticket" onClick={() => setOpen(true)} />
      <Outcome item={item} />
      <ProposalDialog
        open={open}
        title={`New ${item.createIssueType ?? "issue"} in ${item.createProjectKey ?? "Jira"}`}
        onOpenChange={setOpen}
        onDecide={onDecide}
      >
        <IssueKind item={item} />
        <h1 className="mt-2 text-xl font-semibold text-foreground">
          {item.createSummary}
        </h1>
        <FieldRows
          rows={fields}
          className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2"
        />
        <DialogSection title="Description">
          {item.createDescription ? (
            <Markdown text={item.createDescription} />
          ) : (
            <div className="text-sm text-muted-foreground">No description.</div>
          )}
        </DialogSection>
        {item.linkChanges?.length ? (
          <DialogSection title="Links">
            <LinkRows item={item} />
          </DialogSection>
        ) : null}
      </ProposalDialog>
    </div>
  );
}

function CommentItem({
  item,
  onDecide,
}: {
  item: JiraItem;
  onDecide: ProposalDecide;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <div>
        <span className="text-muted-foreground">comment on </span>
        <IssueKeyLink item={item} />
      </div>
      {item.commentBody ? <ClippedMarkdown text={item.commentBody} /> : null}
      <ReadFullButton label="Read full comment" onClick={() => setOpen(true)} />
      <Outcome item={item} />
      <ProposalDialog
        open={open}
        title={`Comment on ${item.issueKey}`}
        onOpenChange={setOpen}
        onDecide={onDecide}
      >
        <div className="text-sm text-muted-foreground">
          <IssueKeyLink item={item} />
          {item.issueSummary ? ` · ${item.issueSummary}` : ""}
        </div>
        <DialogSection title="Comment">
          {item.commentBody ? <Markdown text={item.commentBody} /> : null}
        </DialogSection>
      </ProposalDialog>
    </div>
  );
}

function IssueKeyLink({ item }: { item: JiraItem }) {
  if (!item.issueUrl)
    return <span className="font-mono text-foreground">{item.issueKey}</span>;
  return (
    <a
      href={item.issueUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-primary hover:underline"
    >
      {item.issueKey}
    </a>
  );
}

function EditItem({ item }: { item: JiraItem }) {
  return (
    <div className="space-y-1">
      <div>
        <IssueKeyLink item={item} />
        {item.issueSummary ? (
          <span className="text-muted-foreground"> · {item.issueSummary}</span>
        ) : null}
        {item.targetTransitionName ? (
          <span className="text-muted-foreground">
            {" "}
            · {item.targetTransitionName}
            {item.targetStatus ? ` → ${item.targetStatus}` : ""}
          </span>
        ) : null}
      </div>
      {item.fieldChanges.length ? (
        <dl className="space-y-0.5">
          {item.fieldChanges.map((change) => (
            <div key={change.fieldId} className="flex flex-wrap gap-1.5">
              <dt className="text-muted-foreground">{change.label}</dt>
              <dd className="min-w-0 break-words">
                <span className="text-muted-foreground line-through">
                  {change.from || EMPTY_VALUE}
                </span>{" "}
                →{" "}
                <span className="text-foreground">
                  {change.to || EMPTY_VALUE}
                </span>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <LinkRows item={item} />
      <Outcome item={item} />
    </div>
  );
}

/** Where a top/bottom rank read its ordering from, in the card's own words. */
function rankScopeText(item: JiraItem): string | null {
  const scope = item.rankScope;
  if (!scope) return null;
  return scope.kind === "board"
    ? `board ${scope.boardId} ${scope.epics ? "epic list" : "backlog"}`
    : `${scope.parentIssueKey}'s children`;
}

/**
 * A rank proposal as the move it describes: the issues in their requested
 * order, where they land, and — once approved — each chained rank call and the
 * ordering Jira reported afterwards. A step with no outcome was never
 * attempted, which is what makes a partial batch readable.
 */
function RankItem({ item }: { item: JiraItem }) {
  const scope = rankScopeText(item);
  const target = item.rankTargetIssueKey;
  // Before approval no step has run, so no step carries an outcome yet.
  const executed = (item.rankSteps ?? []).some(
    (step) => step.resultOk !== undefined,
  );
  return (
    <div className="space-y-1">
      <div>
        <span className="text-muted-foreground">rank </span>
        <span className="font-mono text-foreground">
          {(item.rankIssueKeys ?? []).join(", ")}
        </span>
        <span className="text-muted-foreground"> {item.rankPosition}</span>
        {target ? (
          <>
            <span className="text-muted-foreground"> </span>
            <span className="font-mono text-foreground">{target}</span>
          </>
        ) : null}
        {scope ? (
          <span className="text-muted-foreground"> in {scope}</span>
        ) : null}
      </div>
      {item.rankSteps?.length ? (
        <ul className="space-y-0.5">
          {item.rankSteps.map((step, i) => (
            <li key={i} className="text-sm text-muted-foreground">
              <span className="font-mono text-foreground">{step.issueKey}</span>{" "}
              {step.placement}{" "}
              <span className="font-mono text-foreground">
                {step.relativeToIssueKey}
              </span>
              {step.resultOk === false ? (
                <span className="text-destructive"> — {step.error}</span>
              ) : step.resultOk ? (
                <span className="text-success"> — applied</span>
              ) : executed ? (
                <span className="text-muted-foreground"> — not attempted</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.rankResultOrder?.length ? (
        <div className="text-sm text-muted-foreground">
          Order now:{" "}
          <span className="font-mono text-foreground">
            {item.rankResultOrder.join(" → ")}
          </span>
        </div>
      ) : null}
      <Outcome item={item} />
    </div>
  );
}

const SPRINT_FIELD_LABELS: Record<JiraSprintChangeDisplay["field"], string> = {
  name: "Name",
  startDate: "Start",
  endDate: "End",
  goal: "Goal",
};

/** A sprint value as the user reads it: dates in local time, text as is. */
function sprintValueText(
  field: JiraSprintChangeDisplay["field"],
  value: string | null,
): string {
  if (!value) return EMPTY_VALUE;
  if (field !== "startDate" && field !== "endDate") return value;
  const date = parsePropertyDate(value);
  return date ? formatPropertyDate(date, Date.now()).label : value;
}

/**
 * A sprint edit as the change it makes: the sprint, each changed property
 * from → to, and — once approved — the dates Jira reports it holds now.
 */
function SprintItem({ item }: { item: JiraItem }) {
  const sprint = item.sprint;
  if (!sprint) return null;
  const result = sprint.result;
  return (
    <div className="space-y-1">
      <div>
        <span className="text-muted-foreground">sprint </span>
        <span className="text-foreground">{sprint.name}</span>
        <span className="text-muted-foreground"> · {sprint.state}</span>
      </div>
      <dl className="space-y-0.5">
        {sprint.changes.map((change) => (
          <div key={change.field} className="flex flex-wrap gap-1.5">
            <dt className="text-muted-foreground">
              {SPRINT_FIELD_LABELS[change.field]}
            </dt>
            <dd className="min-w-0 break-words">
              <span className="text-muted-foreground line-through">
                {sprintValueText(change.field, change.from)}
              </span>{" "}
              →{" "}
              <span className="text-foreground">
                {sprintValueText(change.field, change.to)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      {result ? (
        <div className="text-sm text-muted-foreground">
          Now:{" "}
          <span className="text-foreground">
            {sprintValueText("startDate", result.startDate)} –{" "}
            {sprintValueText("endDate", result.endDate)}
          </span>
        </div>
      ) : null}
      <Outcome item={item} />
    </div>
  );
}
