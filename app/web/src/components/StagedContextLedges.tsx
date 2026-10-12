import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FileText,
  X,
} from "lucide-react";
import type { TaskItem } from "@assistant/shared";
import { IconButton } from "./common/IconButton.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";
import { InlineDocumentEmbed } from "./InlineDocumentEmbed.tsx";
import { Markdown } from "./Markdown.tsx";
import { Button } from "@/components/ui/button";
import { Item, ItemActions } from "@/components/ui/item";
import {
  documentTargetRawUrl,
  resolveInternalDocumentTarget,
} from "../lib/documentTargets.ts";
import { dataOf, errorOf, type LoadState } from "../lib/loadState.ts";
import { useFetchState } from "../hooks/useFetchState.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { servedFileKind } from "../lib/servedFiles.ts";

/**
 * One staged-context strip on the composer's shelf: what the new session
 * starts with, on one line that unfolds to the thing itself, with Open and
 * Remove beside it. The shell the Task and document strips share.
 */
function StagedContextStrip({
  icon,
  lead,
  label,
  openLabel,
  removeLabel,
  onOpen,
  onRemove,
  onExpand,
  children,
}: {
  icon: ReactNode;
  /** What it is, before its name: "Task #758", "Starting from". */
  lead: string;
  label: ReactNode;
  openLabel: string;
  removeLabel: string;
  onOpen: () => void;
  onRemove: () => void;
  /** Called on every unfold, so the host can fetch what the body shows. */
  onExpand?: (() => void) | undefined;
  /** The body, rendered only while unfolded. */
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="min-w-0">
      <Item
        size="xs"
        className="flex-nowrap gap-1 rounded-none py-0 pr-1.5 pl-0 hover:bg-muted dark:hover:bg-muted/50"
      >
        <Button
          variant="ghost"
          size="sm"
          // The whole row takes the hover (its `Item`); open is not a hover
          // state — as every strip's rows.
          className="h-7 min-w-0 flex-1 justify-start rounded-none bg-clip-border text-sm font-normal text-muted-foreground hover:bg-transparent aria-expanded:bg-transparent aria-expanded:text-muted-foreground dark:hover:bg-transparent"
          aria-expanded={open}
          onClick={() => {
            if (!open) onExpand?.();
            setOpen((value) => !value);
          }}
        >
          <Chevron aria-hidden="true" />
          {icon}
          <span className="shrink-0">{lead}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            {label}
          </span>
        </Button>
        <ItemActions className="gap-0.5">
          <IconButton label={openLabel} size="icon-xs" onClick={onOpen}>
            <ArrowUpRight />
          </IconButton>
          <IconButton label={removeLabel} size="icon-xs" onClick={onRemove}>
            <X />
          </IconButton>
        </ItemActions>
      </Item>
      {open ? (
        <div className="max-h-72 overflow-y-auto border-t px-3 py-2 text-sm">
          {children()}
        </div>
      ) : null}
    </div>
  );
}

/**
 * @component StagedTaskLedge
 * @purpose The Task a new session will work on, as a composer-shelf strip:
 * `Task #id` and its title on the row, the title as a heading and the
 * description when unfolded.
 * @useWhen A Task is staged for the first send of a new session.
 * @avoidWhen A running session — its Task is in the title bar.
 */
export function StagedTaskLedge({
  task,
  detail,
  onRequestDetail,
  onOpen,
  onRemove,
}: {
  task: { taskId: string; title: string };
  /** The Task's on-demand detail (`state.taskDetails`); absent until asked. */
  detail: LoadState<TaskItem | null> | undefined;
  onRequestDetail: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const item = detail ? dataOf(detail) : undefined;
  const error = detail ? errorOf(detail) : undefined;
  return (
    <StagedContextStrip
      icon={<ClipboardList aria-hidden className="size-3.5 shrink-0" />}
      lead={`Task #${task.taskId}`}
      label={<span className="truncate">{task.title}</span>}
      openLabel={`Open Task-${task.taskId}`}
      removeLabel="Don't work on this task"
      onOpen={onOpen}
      onRemove={onRemove}
      // Ask only when nothing is held: a loaded detail stays current by its
      // own broadcasts.
      onExpand={item === undefined ? onRequestDetail : undefined}
    >
      {() =>
        item ? (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-base font-semibold text-foreground">
              {item.title}
            </h3>
            {item.description?.trim() ? (
              <Markdown text={item.description} />
            ) : (
              <p className="text-muted-foreground italic">No description.</p>
            )}
          </div>
        ) : error ? (
          <ErrorNote message={error} onRetry={onRequestDetail} />
        ) : item === null ? (
          <p className="text-muted-foreground">This Task no longer exists.</p>
        ) : (
          <div className="flex flex-col gap-1.5" aria-busy="true">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        )
      }
    </StagedContextStrip>
  );
}

/**
 * @component StagedDocumentLedge
 * @purpose The document a new session starts from, as a composer-shelf strip:
 * its title on the row, the document itself when unfolded — Markdown rendered,
 * text as text, images, HTML and media through the inline embed.
 * @useWhen A document is staged for the first send of a new session.
 */
export function StagedDocumentLedge({
  document,
  onOpen,
  onRemove,
}: {
  document: { href: string; title: string };
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <StagedContextStrip
      icon={<FileText aria-hidden className="size-3.5 shrink-0" />}
      lead="Starting from"
      label={<span className="truncate">{document.title}</span>}
      openLabel={`Open ${document.title}`}
      removeLabel="Don't start from this document"
      onOpen={onOpen}
      onRemove={onRemove}
    >
      {() => <StagedDocumentBody href={document.href} title={document.title} />}
    </StagedContextStrip>
  );
}

/** A staged document's text, for the strip's unfolded body. */
async function fetchDocumentText(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new Error(
      `Could not load the document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function StagedDocumentBody({ href, title }: { href: string; title: string }) {
  const target = resolveInternalDocumentTarget(href);
  const kind = target ? servedFileKind(target.path) : null;
  const textual = kind === "markdown" || kind === "text";
  const rawUrl =
    target && textual ? artifactHttpUrl(documentTargetRawUrl(target)) : null;
  const { state: text } = useFetchState(rawUrl, fetchDocumentText);

  if (!target) return <p className="text-muted-foreground">{title}</p>;
  if (!textual) return <InlineDocumentEmbed target={target} label={title} />;
  const body = dataOf(text);
  const error = errorOf(text);
  if (error) return <ErrorNote message={error} />;
  if (body === undefined)
    return (
      <div className="flex flex-col gap-1.5" aria-busy="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
    );
  return kind === "markdown" ? (
    <Markdown text={body} />
  ) : (
    <pre className="font-mono text-xs whitespace-pre-wrap">{body}</pre>
  );
}
