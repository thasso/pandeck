/**
 * @widget JiraIssueApprovalBody
 * @purpose The Jira detail of `ApprovalCard`: the creates, comments and edits a
 *   `jira_mutate_issue` proposal carries. Markdown bodies render as Jira will
 *   show them (the server converts the same source to ADF on execution), the
 *   card clips a long description to a preview, and "Read full ticket" opens the
 *   whole proposal in a modal with the same Approve/Reject as the card.
 * @payload `JiraIssueApprovalBody` (`ApprovalCard.body`).
 * @useWhen Rendered by `ApprovalCard` for `body.kind === "jiraIssue"`.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Maximize2, XCircle } from "lucide-react";
import type {
  ApprovalDecision,
  JiraIssueApprovalBody as JiraIssueApprovalBodyData,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type JiraItem = JiraIssueMutationItemDisplay;

/** Decision buttons offered while the card is pending; absent once it is not. */
export type JiraDecide = ((decision: ApprovalDecision) => void) | undefined;

export function JiraIssueApprovalBody({
  body,
  onDecide,
}: {
  body: JiraIssueApprovalBodyData;
  onDecide: JiraDecide;
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

/**
 * Markdown clipped to a card-sized window. The fade only paints when there IS
 * more below the fold — a three-line description does not need to look cut.
 * Height is observed rather than measured once: a late image or lazily
 * highlighted code block grows the content after mount.
 */
export function ClippedMarkdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const child of node.children) observer.observe(child);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className="relative">
      <div
        ref={ref}
        className="max-h-48 min-w-0 overflow-hidden text-foreground"
      >
        <Markdown text={text} density="compact" />
      </div>
      {clipped ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
      ) : null}
    </div>
  );
}

function ReadFullButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Maximize2 />
      {label}
    </Button>
  );
}

function CreateItem({
  item,
  onDecide,
}: {
  item: JiraItem;
  onDecide: JiraDecide;
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
      <JiraProposalDialog
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
      </JiraProposalDialog>
    </div>
  );
}

function CommentItem({
  item,
  onDecide,
}: {
  item: JiraItem;
  onDecide: JiraDecide;
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
      <JiraProposalDialog
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
      </JiraProposalDialog>
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

function DialogSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-4">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

/**
 * The full proposal at reading size. A dialog rather than the document viewer:
 * the ticket is not a file anywhere yet, it exists only on this card until
 * Jira accepts it. The decision buttons are the card's, so approving from here
 * is the same act as approving on the card.
 */
function JiraProposalDialog({
  title,
  open,
  onOpenChange,
  onDecide,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecide: JiraDecide;
  children: React.ReactNode;
}) {
  const decide = (decision: ApprovalDecision) => {
    onDecide?.(decision);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-label={title}
        className="flex max-h-11/12 flex-col sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
        <DialogFooter>
          {onDecide ? (
            <>
              <Button variant="outline" onClick={() => decide("rejected")}>
                <XCircle />
                Reject
              </Button>
              <Button onClick={() => decide("approved")}>
                <CheckCircle2 />
                Approve
              </Button>
            </>
          ) : (
            <DialogClose render={<Button variant="outline" />}>
              Close
            </DialogClose>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
