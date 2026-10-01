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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  ExternalLink,
  Maximize2,
  X,
  XCircle,
} from "lucide-react";
import type {
  ApprovalDecision,
  JiraIssueApprovalBody as JiraIssueApprovalBodyData,
  JiraIssueMutationItemDisplay,
} from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { DialogAction, DialogCancelButton } from "./ui/dialog.tsx";
import { wrapTabWithin } from "./ui/focusTrap.ts";

type JiraItem = JiraIssueMutationItemDisplay;

/** The dialog's own controls plus whatever the rendered Markdown makes reachable. */
const DIALOG_FOCUSABLE = 'button, a[href], [tabindex="0"]';

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
    <ul className="space-y-2">
      {body.items.map((item, i) => (
        <li key={item.clientId || i} className="text-caption">
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
  if (!item.error && !item.resultIssueUrl && !item.warning) return null;
  return (
    <div className="space-y-0.5">
      {item.error ? (
        <div className="text-caption text-danger">{item.error}</div>
      ) : item.resultIssueUrl ? (
        <a
          href={item.resultIssueUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-caption text-green-600 hover:underline dark:text-green-400"
        >
          <ExternalLink size={11} />
          {outcomeLabel(item)}
        </a>
      ) : null}
      {item.warning ? (
        <div className="text-caption text-yellow-600 dark:text-yellow-400">
          {item.warning}
        </div>
      ) : null}
    </div>
  );
}

/** `Project · Type` in the accent chip every create wears, in card and modal. */
function IssueKind({ item }: { item: JiraItem }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-micro text-accent">
      {item.createProjectKey}
      <span className="text-accent/60">·</span>
      <span className="font-sans">{item.createIssueType}</span>
    </span>
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
          <dt className="shrink-0 text-faint">{row.label}</dt>
          <dd className="min-w-0 break-words text-fg">{row.value}</dd>
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
        <li key={i} className="text-caption text-muted">
          {link.op === "remove" ? "unlink" : link.relationship}{" "}
          <span className="font-mono text-fg">
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
      <div ref={ref} className="max-h-48 min-w-0 overflow-hidden text-fg">
        <Markdown text={text} density="compact" />
      </div>
      {clipped ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-panel to-transparent" />
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
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-raised px-2 py-1 text-caption text-muted hover:bg-surface hover:text-fg"
    >
      <Maximize2 size={12} />
      {label}
    </button>
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <IssueKind item={item} />
        <span className="min-w-0 flex-1 font-medium text-fg">
          {item.createSummary}
        </span>
      </div>
      <FieldRows rows={fields} className="flex flex-wrap gap-x-4 gap-y-0.5" />
      {item.createDescription ? (
        <ClippedMarkdown text={item.createDescription} />
      ) : (
        <div className="text-faint">No description.</div>
      )}
      <LinkRows item={item} />
      <ReadFullButton label="Read full ticket" onClick={() => setOpen(true)} />
      <Outcome item={item} />
      {open ? (
        <JiraProposalDialog
          title={`New ${item.createIssueType ?? "issue"} in ${item.createProjectKey ?? "Jira"}`}
          onClose={() => setOpen(false)}
          onDecide={onDecide}
        >
          <div className="flex flex-wrap items-center gap-2">
            <IssueKind item={item} />
          </div>
          <h1 className="mt-2 text-title font-semibold text-fg">
            {item.createSummary}
          </h1>
          <FieldRows
            rows={fields}
            className="mt-3 grid gap-x-6 gap-y-1 text-caption sm:grid-cols-2"
          />
          <DialogSection title="Description">
            {item.createDescription ? (
              <Markdown text={item.createDescription} />
            ) : (
              <div className="text-caption text-faint">No description.</div>
            )}
          </DialogSection>
          {item.linkChanges?.length ? (
            <DialogSection title="Links">
              <LinkRows item={item} />
            </DialogSection>
          ) : null}
        </JiraProposalDialog>
      ) : null}
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
    <div className="space-y-2">
      <div>
        <span className="text-muted">comment on </span>
        <IssueKeyLink item={item} />
      </div>
      {item.commentBody ? <ClippedMarkdown text={item.commentBody} /> : null}
      <ReadFullButton label="Read full comment" onClick={() => setOpen(true)} />
      <Outcome item={item} />
      {open ? (
        <JiraProposalDialog
          title={`Comment on ${item.issueKey}`}
          onClose={() => setOpen(false)}
          onDecide={onDecide}
        >
          <div className="text-caption text-muted">
            <IssueKeyLink item={item} />
            {item.issueSummary ? ` · ${item.issueSummary}` : ""}
          </div>
          <DialogSection title="Comment">
            {item.commentBody ? <Markdown text={item.commentBody} /> : null}
          </DialogSection>
        </JiraProposalDialog>
      ) : null}
    </div>
  );
}

function IssueKeyLink({ item }: { item: JiraItem }) {
  if (!item.issueUrl)
    return <span className="font-mono text-fg">{item.issueKey}</span>;
  return (
    <a
      href={item.issueUrl}
      target="_blank"
      rel="noreferrer noopener"
      className="font-mono text-accent hover:underline"
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
          <span className="text-muted"> · {item.issueSummary}</span>
        ) : null}
        {item.targetTransitionName ? (
          <span className="text-muted">
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
              <dt className="text-faint">{change.label}</dt>
              <dd className="min-w-0 break-words">
                <span className="text-muted line-through">
                  {change.from || EMPTY_VALUE}
                </span>{" "}
                → <span className="text-fg">{change.to || EMPTY_VALUE}</span>
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
        <span className="text-muted">rank </span>
        <span className="font-mono text-fg">
          {(item.rankIssueKeys ?? []).join(", ")}
        </span>
        <span className="text-muted"> {item.rankPosition}</span>
        {target ? (
          <>
            <span className="text-muted"> </span>
            <span className="font-mono text-fg">{target}</span>
          </>
        ) : null}
        {scope ? <span className="text-muted"> in {scope}</span> : null}
      </div>
      {item.rankSteps?.length ? (
        <ul className="space-y-0.5">
          {item.rankSteps.map((step, i) => (
            <li key={i} className="text-caption text-muted">
              <span className="font-mono text-fg">{step.issueKey}</span>{" "}
              {step.placement}{" "}
              <span className="font-mono text-fg">
                {step.relativeToIssueKey}
              </span>
              {step.resultOk === false ? (
                <span className="text-danger"> — {step.error}</span>
              ) : step.resultOk ? (
                <span className="text-green-600 dark:text-green-400">
                  {" "}
                  — applied
                </span>
              ) : executed ? (
                <span className="text-faint"> — not attempted</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {item.rankResultOrder?.length ? (
        <div className="text-caption text-muted">
          Order now:{" "}
          <span className="font-mono text-fg">
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
      <div className="mb-1.5 text-micro font-semibold uppercase tracking-wide text-faint">
        {title}
      </div>
      {children}
    </section>
  );
}

/**
 * The full proposal at reading size. A modal-band surface (ui-shell.md, 70)
 * rather than the document viewer: the ticket is not a file anywhere yet, it
 * exists only on this card until Jira accepts it. Holds focus like
 * `ImageLightbox` — Tab wraps inside it — and reads Escape itself so the
 * shortcut cannot also reach whatever raised it; the decision buttons are the card's, so approving from
 * here is the same act as approving on the card.
 */
function JiraProposalDialog({
  title,
  onClose,
  onDecide,
  children,
}: {
  title: string;
  onClose: () => void;
  onDecide: JiraDecide;
  children: React.ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    surfaceRef.current?.focus({ preventScroll: true });
    return () => previous?.focus?.();
  }, []);
  const decide = (decision: ApprovalDecision) => {
    onDecide?.(decision);
    onClose();
  };
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        ref={surfaceRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          wrapTabWithin(event, surfaceRef.current, DIALOG_FOCUSABLE);
        }}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1 truncate text-body font-semibold text-fg">
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-raised hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {children}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {onDecide ? (
            <>
              <DialogCancelButton onClick={() => decide("rejected")}>
                <span className="inline-flex items-center gap-1.5">
                  <XCircle size={12} />
                  Reject
                </span>
              </DialogCancelButton>
              <DialogAction
                icon={<CheckCircle2 size={12} />}
                onClick={() => decide("approved")}
              >
                Approve
              </DialogAction>
            </>
          ) : (
            <DialogCancelButton onClick={onClose}>Close</DialogCancelButton>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
