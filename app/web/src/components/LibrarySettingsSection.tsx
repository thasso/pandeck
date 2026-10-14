/**
 * A user-owned library's settings page, shared by the Skills
 * ([Task-531](pa://task/531), `docs/skills.md`) and Agents
 * (`docs/agent-definitions.md`) pages: what the server's fresh scan found, the
 * folders that cannot be used with their reason, one entry's files, and its
 * history. Each page supplies only its copy and what a row adds (a skill's
 * on/off switch, an agent's runtime).
 *
 * The user authors the library by hand and owns its Git repository, so the
 * library itself is only reported here. Two lists, and the second one is the
 * point: a folder that cannot be used is shown WITH its reason rather than
 * dropped, because a silently missing entry is the failure a hand-authored
 * library actually produces.
 *
 * Opening the section is what asks for the scan (the library's topic), so the
 * states here are the ordinary five: a first load, a refresh that keeps the
 * rows on screen, an authoritative empty library, and a failed read that adds
 * a note beside whatever was already there.
 *
 * Opening a row reads that entry's manifest ([Task-614](pa://task/614)). The
 * body is NOT in the list — it is fetched per selection over
 * `/api/<library>/detail` and keyed by the selected NAME through
 * `useFetchState`, which is what makes the important guarantee structural
 * rather than remembered: switching rows drops the previous answer during
 * render, so one entry's instructions can never be read under another's name.
 * The library is hand-authored, so a fresh scan can also disagree with what is
 * on screen; a rescan therefore re-reads the open entry in place rather than
 * leaving a body that no longer matches the file an agent would be given.
 */
import {
  Download,
  ExternalLink,
  File,
  FileText,
  Folder,
  GitCommitHorizontal,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MAX_ENTRY_BODY_BYTES,
  MAX_ENTRY_FILE_PREVIEW_BYTES,
  MAX_ENTRY_TREE_DEPTH,
  MAX_ENTRY_TREE_ENTRIES,
  MAX_ENTRY_TREE_METADATA_BYTES,
  type EntryDetail,
  type EntryDetailResponse,
  type EntryDiagnostic,
  type EntryFilePreviewResponse,
  type EntryFileTreeEntry,
  type EntryHistory,
  type EntryLibraryList,
  type EntrySummary,
  type LibraryTopic,
} from "@assistant/shared";
import { useFetchState } from "../hooks/useFetchState.ts";
import type { LoadState } from "../lib/loadState.ts";
import { dataOf, errorOf, isInitialLoad, isPending } from "../lib/loadState.ts";
import { libraryApi, type LibraryApi } from "../lib/libraryApi.ts";
import { relativeTime } from "../lib/sessionRows.ts";
import { Markdown } from "./Markdown.tsx";
import { PageHeader } from "./PageHeader.tsx";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { IconButton } from "./common/IconButton.tsx";
import { LinkButton } from "./common/LinkButton.tsx";
import { CodeBlock } from "./common/CodeBlock.tsx";
import { Tree, type TreeNode } from "./common/Tree.tsx";
import {
  EmptyBox,
  ErrorNote,
  PaneLoading,
  RefreshIndicator,
} from "./common/load.tsx";

/** What one library's page says; the rest of the page is shared. */
export interface LibraryPageCopy {
  library: LibraryTopic;
  /** Page heading, e.g. "Skills". */
  title: string;
  /** One entry, e.g. "skill". */
  noun: string;
  /** The manifest every entry folder is recognized by, e.g. `SKILL.md`. */
  manifestFile: string;
  intro: ReactNode;
  listTitle: string;
  listDescription: ReactNode;
  /** The library has no folders at all. */
  emptyText: ReactNode;
  /** Every folder has a problem. */
  noneUsableText: ReactNode;
  diagnosticsDescription: ReactNode;
}

export function LibrarySettingsSection({
  copy,
  library,
  rowMeta,
  rowAction,
  initialSelected = null,
}: {
  copy: LibraryPageCopy;
  library: LoadState<EntryLibraryList>;
  /** Extra lines under a row's description (an agent's runtime). */
  rowMeta?:
    ((entry: EntrySummary, list: EntryLibraryList) => ReactNode) | undefined;
  /** A control beside a row (a skill's on/off switch). */
  rowAction?: ((entry: EntrySummary) => ReactNode) | undefined;
  /** An entry to open first, e.g. one a link named. */
  initialSelected?: string | null | undefined;
}) {
  const list = dataOf(library);
  const error = errorOf(library);
  const refreshing = isPending(library) && list !== undefined;
  const api = libraryApi(copy.library);

  const [selected, setSelected] = useState<string | null>(initialSelected);
  const detail = useFetchState<EntryDetailResponse>(selected, api.detail);
  const { reload } = detail;

  // A rescan is authoritative over the open body too. Reloading the SAME key
  // keeps it on screen while it refetches (R2); a selection made in the same
  // pass is already loading its own answer, so only a NEW list reloads.
  const lastList = useRef(list);
  useEffect(() => {
    if (lastList.current === list) return;
    lastList.current = list;
    reload();
  }, [list, reload]);

  const select = useCallback((name: string) => {
    setSelected((current) => (current === name ? null : name));
  }, []);
  const close = useCallback(() => setSelected(null), []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold">{copy.title}</h2>
        {refreshing ? (
          <RefreshIndicator label={`Rescanning ${copy.library}`} />
        ) : null}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{copy.intro}</p>
      {list ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Library folder: <code>{list.libraryPath}</code>
        </p>
      ) : null}

      {error ? <ErrorNote className="mt-4" message={error} /> : null}

      {isInitialLoad(library) ? (
        <PaneLoading
          className="mt-6"
          label={`Scanning the ${copy.library} library…`}
        />
      ) : null}

      {list ? (
        <EntryList
          copy={copy}
          list={list}
          rowMeta={rowMeta}
          rowAction={rowAction}
          selected={selected}
          onSelect={select}
        />
      ) : null}

      {selected !== null ? (
        <EntryDetailPane
          key={selected}
          copy={copy}
          api={api}
          name={selected}
          state={detail.state}
          onReload={reload}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function EntryList({
  copy,
  list,
  rowMeta,
  rowAction,
  selected,
  onSelect,
}: {
  copy: LibraryPageCopy;
  list: EntryLibraryList;
  rowMeta:
    ((entry: EntrySummary, list: EntryLibraryList) => ReactNode) | undefined;
  rowAction: ((entry: EntrySummary) => ReactNode) | undefined;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const empty = list.entries.length === 0 && list.diagnostics.length === 0;
  return (
    <>
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{copy.listTitle}</CardTitle>
          <CardDescription>{copy.listDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyBox>{copy.emptyText}</EmptyBox>
          ) : list.entries.length === 0 ? (
            <EmptyBox>{copy.noneUsableText}</EmptyBox>
          ) : (
            <ItemGroup className="gap-2">
              {list.entries.map((entry) => (
                <EntryRow
                  key={entry.path}
                  copy={copy}
                  entry={entry}
                  meta={rowMeta?.(entry, list)}
                  action={rowAction?.(entry)}
                  open={selected === entry.name}
                  onSelect={onSelect}
                />
              ))}
            </ItemGroup>
          )}
        </CardContent>
      </Card>

      {list.diagnostics.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Folders that need a fix</CardTitle>
            <CardDescription>{copy.diagnosticsDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <ItemGroup className="gap-2">
              {diagnosticKeys(list.diagnostics).map(([key, diagnostic]) => (
                <DiagnosticRow key={key} diagnostic={diagnostic} />
              ))}
            </ItemGroup>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/**
 * A key per diagnostic row. One file can carry several diagnostics of one
 * code (an agent's unknown keys), so the key counts them: a path and code
 * alone would let a rescan keep a row the server no longer reports.
 */
function diagnosticKeys(
  diagnostics: readonly EntryDiagnostic[],
): [string, EntryDiagnostic][] {
  const seen = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const base = `${diagnostic.path}:${diagnostic.code}`;
    const at = seen.get(base) ?? 0;
    seen.set(base, at + 1);
    return [`${base}:${at}`, diagnostic];
  });
}

/**
 * One available entry. The metadata is a BUTTON that opens the body: a whole
 * clickable row would nest a row control (a skill's toggle) inside a control,
 * and that control is a different decision from reading the instructions.
 */
function EntryRow({
  copy,
  entry,
  meta,
  action,
  open,
  onSelect,
}: {
  copy: LibraryPageCopy;
  entry: EntrySummary;
  meta: ReactNode;
  action: ReactNode;
  open: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <div role="listitem" className="flex items-center gap-3">
      <Item
        variant={open ? "muted" : "outline"}
        className="min-w-0 flex-1"
        render={
          <button
            type="button"
            onClick={() => onSelect(entry.name)}
            aria-expanded={open}
            aria-controls={`${copy.noun}-detail`}
          />
        }
      >
        <ItemContent className="min-w-0">
          <ItemTitle>
            <span className="truncate">{entry.name}</span>
          </ItemTitle>
          <ItemDescription>{entry.description}</ItemDescription>
          {meta}
          <ItemDescription>
            <code>{entry.path}</code>
          </ItemDescription>
        </ItemContent>
      </Item>
      {action}
    </div>
  );
}

/**
 * The open entry's manifest, files and history.
 *
 * The heading is the name that was ASKED for, and the body may only ever be the
 * answer to that ask: `useFetchState` drops the previous entry's document when
 * the key changes, so a slow read shows this entry's placeholder rather than
 * the last one's instructions. A read that failed keeps nothing under the new
 * name either — the error stands alone, because the last good body belonged to
 * another entry.
 *
 * An `invalid` answer is not an error state: the library moved (the folder was
 * renamed, broken, or its name became ambiguous) and the reason is the content.
 */
function EntryDetailPane({
  copy,
  api,
  name,
  state,
  onReload,
  onClose,
}: {
  copy: LibraryPageCopy;
  api: LibraryApi;
  name: string;
  state: LoadState<EntryDetailResponse>;
  onReload: () => void;
  onClose: () => void;
}) {
  const detail = dataOf(state);
  const error = errorOf(state);
  const rereading = isPending(state) && detail !== undefined;
  const [selectedPath, setSelectedPath] = useState(copy.manifestFile);

  return (
    <Card id={`${copy.noun}-detail`} className="mt-4">
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        {/* The source path comes from the answer: an entry's folder need not
            be named after it, so there is nothing honest to show before. */}
        {detail?.path ? (
          <CardDescription>
            <code>{detail.path}</code>
          </CardDescription>
        ) : null}
        <CardAction className="flex items-center gap-1">
          {rereading ? (
            <RefreshIndicator label={`Rereading ${copy.manifestFile}`} />
          ) : null}
          <IconButton label={`Reread ${name}`} onClick={onReload}>
            <RefreshCw />
          </IconButton>
          <IconButton label={`Close ${name}`} onClick={onClose}>
            <X />
          </IconButton>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? <ErrorNote message={error} /> : null}

        {isInitialLoad(state) ? (
          <PaneLoading label={`Reading ${name}/${copy.manifestFile}…`} />
        ) : null}

        {detail?.kind === "invalid" ? (
          <EntryNote>{detail.error}</EntryNote>
        ) : null}

        {detail?.kind === "entry" ? (
          <>
            <p className="text-sm text-muted-foreground">
              {detail.description}
            </p>
            <EntryFileBrowser
              copy={copy}
              api={api}
              detail={detail}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
            />
            <EntryHistoryList api={api} name={detail.name} detail={detail} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The entry folder's recent commits. Read with the entry, and again whenever a
 * rescan rebuilds it, so an edit made outside the app shows up here too.
 */
function EntryHistoryList({
  api,
  name,
  detail,
}: {
  api: LibraryApi;
  name: string;
  detail: EntryDetail;
}) {
  const { state, reload } = useFetchState<EntryHistory>(name, api.history);
  const lastDetail = useRef(detail);
  useEffect(() => {
    if (lastDetail.current === detail) return;
    lastDetail.current = detail;
    reload();
  }, [detail, reload]);
  const history = dataOf(state);
  const error = errorOf(state);
  const rereading = isPending(state) && history !== undefined;

  return (
    <div className="mt-3 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b p-3 text-sm font-medium">
        History
        {rereading ? (
          <RefreshIndicator label={`Rereading the history of ${name}`} />
        ) : null}
      </div>
      {error ? (
        <ErrorNote className="m-3" message={error} onRetry={reload} />
      ) : null}
      {isInitialLoad(state) ? (
        <PaneLoading
          className="m-3"
          label={`Reading the history of ${name}…`}
        />
      ) : null}
      {history && history.commits.length === 0 ? (
        <EmptyBox className="m-3">
          No commits yet. Changes made by hand show up here once they are
          committed.
        </EmptyBox>
      ) : null}
      {history && history.commits.length > 0 ? (
        <ItemGroup className="gap-0 p-1" aria-label={`History of ${name}`}>
          {history.commits.map((commit) => (
            <Item key={commit.shortCommit} size="sm" role="listitem">
              <ItemMedia variant="icon">
                <GitCommitHorizontal />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  <span className="truncate">{commit.subject}</span>
                </ItemTitle>
                <ItemDescription>
                  <code>{commit.shortCommit}</code> · {commit.author} ·{" "}
                  {relativeTime(Date.parse(commit.date))}
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
          {history.truncated ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">
              Older commits are not shown.
            </p>
          ) : null}
        </ItemGroup>
      ) : null}
    </div>
  );
}

interface EntryBrowserNode {
  entry: EntryFileTreeEntry;
}

function EntryFileBrowser({
  copy,
  api,
  detail,
  selectedPath,
  onSelectPath,
}: {
  copy: LibraryPageCopy;
  api: LibraryApi;
  detail: EntryDetail;
  selectedPath: string;
  onSelectPath: (path: string) => void;
}) {
  const nodes = useMemo(() => entryTreeNodes(detail.files.entries), [detail]);
  const selectedEntry = findEntryFile(detail.files.entries, selectedPath);
  const expanded = useMemo(
    () =>
      detail.files.entries
        .filter((entry) => entry.type === "directory")
        .map((entry) => entry.path),
    [detail],
  );

  return (
    <div className="mt-3 overflow-hidden rounded-lg border">
      <div className="border-b p-3">
        <div className="text-sm font-medium">Files</div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          {detail.files.entryCount}{" "}
          {detail.files.entryCount === 1 ? "entry" : "entries"}
          {detail.files.truncated ? ", bounded listing" : ""}
        </div>
        {detail.files.truncated ? (
          <EntryNote>{entryTreeLimitDiagnostic(detail.files.limits)}</EntryNote>
        ) : null}
        {detail.files.diagnostics.map((diagnostic) => (
          <EntryNote key={diagnostic}>{diagnostic}</EntryNote>
        ))}
      </div>
      {nodes.length === 0 ? (
        <EmptyBox className="m-3">No files could be listed.</EmptyBox>
      ) : (
        <Tree
          items={nodes}
          defaultExpandedIds={expanded}
          selectedIds={[selectedPath]}
          onSelectionChange={(ids) => {
            const path = ids.at(-1);
            if (!path) return;
            const entry = findEntryFile(detail.files.entries, path);
            if (entry?.type === "file") onSelectPath(path);
          }}
          compact
          showGuides
          aria-label={`${detail.name} files`}
          className="max-h-64 overflow-y-auto p-1"
          getRowClassName={(node) =>
            node.data.entry.type === "symlink" ? "text-muted-foreground" : ""
          }
          renderNode={(node) => <EntryFileTreeRow entry={node.data.entry} />}
        />
      )}
      <EntryFileViewer
        copy={copy}
        api={api}
        detail={detail}
        entry={selectedEntry}
        path={selectedPath}
      />
    </div>
  );
}

function EntryFileTreeRow({ entry }: { entry: EntryFileTreeEntry }) {
  const Icon =
    entry.type === "directory"
      ? Folder
      : entry.type === "symlink"
        ? ExternalLink
        : File;
  return (
    <div className="flex min-w-0 items-center gap-2 py-1 text-sm">
      <Icon size={13} className="shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
      {entry.type === "file" && entry.bytes !== undefined ? (
        <span className="ml-auto shrink-0 text-muted-foreground">
          {formatBytes(entry.bytes)}
        </span>
      ) : null}
    </div>
  );
}

function EntryFileViewer({
  copy,
  api,
  detail,
  entry,
  path,
}: {
  copy: LibraryPageCopy;
  api: LibraryApi;
  detail: EntryDetail;
  entry: EntryFileTreeEntry | undefined;
  path: string;
}) {
  if (!entry || entry.type !== "file") {
    return (
      <div className="border-t p-3">
        <EmptyBox>
          This file is no longer present in the bounded listing.
        </EmptyBox>
      </div>
    );
  }
  const rawUrl = api.fileUrl(detail.name, path);
  const image = entry.mimeType?.startsWith("image/") === true;
  const textLike = isTextMimeType(entry.mimeType);

  return (
    <div className="border-t">
      <PageHeader
        density="compact"
        icon={<FileText size={15} />}
        title={entry.name}
        subtitle={path}
        objectOverflow={false}
        actions={
          <div className="flex items-center gap-1">
            <LinkButton
              label={`Open raw ${path}`}
              variant="ghost"
              size="icon-sm"
              href={rawUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink />
            </LinkButton>
            <LinkButton
              label={`Download ${path}`}
              variant="ghost"
              size="icon-sm"
              href={rawUrl}
              download={entry.name}
            >
              <Download />
            </LinkButton>
          </div>
        }
      />
      {path === copy.manifestFile ? (
        <ManifestMarkdown copy={copy} detail={detail} />
      ) : image ? (
        <div className="flex min-h-48 items-center justify-center p-4">
          <img
            src={rawUrl}
            alt={entry.name}
            className="max-h-96 max-w-full rounded-lg border object-contain"
          />
        </div>
      ) : textLike ? (
        <EntryTextFile api={api} name={detail.name} entry={entry} />
      ) : (
        <UnsupportedEntryFile entry={entry} rawUrl={rawUrl} />
      )}
    </div>
  );
}

function ManifestMarkdown({
  copy,
  detail,
}: {
  copy: LibraryPageCopy;
  detail: EntryDetail;
}) {
  return (
    <div className="p-3">
      {detail.truncated ? (
        <div className="mb-3 text-sm text-muted-foreground">
          Showing the first {formatBytes(MAX_ENTRY_BODY_BYTES)} of this{" "}
          {formatBytes(detail.bytes)} file. Open it raw to read the rest.
        </div>
      ) : null}
      {detail.markdown ? (
        <Markdown text={detail.markdown} />
      ) : (
        <EmptyBox>
          This <code>{copy.manifestFile}</code> has nothing below its
          frontmatter.
        </EmptyBox>
      )}
    </div>
  );
}

function EntryTextFile({
  api,
  name,
  entry,
}: {
  api: LibraryApi;
  name: string;
  entry: EntryFileTreeEntry;
}) {
  const key = `${name}\0${entry.path}`;
  const { state, reload } = useFetchState<EntryFilePreviewResponse>(
    key,
    api.filePreview,
  );
  const lastEntry = useRef(entry);
  useEffect(() => {
    const previous = lastEntry.current;
    lastEntry.current = entry;
    // A different path already changes the fetch key and starts its first
    // request. Only reload when the same path was rebuilt by a rescan.
    if (previous.path !== entry.path || previous === entry) return;
    reload();
  }, [entry, reload]);
  const preview = dataOf(state);
  const error = errorOf(state);

  if (isInitialLoad(state)) {
    return <PaneLoading className="m-3" label={`Loading ${entry.path}…`} />;
  }
  if (!preview) {
    return (
      <ErrorNote
        className="m-3"
        message={error ?? "File not loaded."}
        onRetry={reload}
      />
    );
  }
  if (preview.kind === "binary") {
    return (
      <UnsupportedEntryFile
        entry={entry}
        rawUrl={api.fileUrl(name, entry.path)}
      />
    );
  }
  const markdown = preview.mimeType.startsWith("text/markdown");
  return (
    <div className="space-y-3 p-3">
      {error ? <ErrorNote message={error} onRetry={reload} /> : null}
      {preview.truncated ? (
        <div className="text-sm text-muted-foreground">
          Showing the first {formatBytes(MAX_ENTRY_FILE_PREVIEW_BYTES)} of this{" "}
          {formatBytes(preview.bytes)} file.
        </div>
      ) : null}
      {markdown ? (
        preview.text ? (
          <Markdown text={preview.text} />
        ) : (
          <EmptyBox>This file is empty.</EmptyBox>
        )
      ) : (
        <CodeBlock
          code={preview.text}
          filename={entry.name}
          showLineNumbers
          collapsedLines={Number.MAX_SAFE_INTEGER}
        />
      )}
    </div>
  );
}

function UnsupportedEntryFile({
  entry,
  rawUrl,
}: {
  entry: EntryFileTreeEntry;
  rawUrl: string;
}) {
  return (
    <EmptyBox
      className="m-3"
      action={
        <LinkButton variant="default" href={rawUrl} download={entry.name}>
          <Download /> Download
        </LinkButton>
      }
    >
      This file type cannot be previewed safely. Open it raw or download it.
    </EmptyBox>
  );
}

function entryTreeNodes(
  entries: EntryFileTreeEntry[],
): TreeNode<EntryBrowserNode>[] {
  return entries.map((entry) => ({
    id: entry.path,
    data: { entry },
    ...(entry.children ? { children: entryTreeNodes(entry.children) } : {}),
  }));
}

function findEntryFile(
  entries: EntryFileTreeEntry[],
  path: string,
): EntryFileTreeEntry | undefined {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    const nested = entry.children && findEntryFile(entry.children, path);
    if (nested) return nested;
  }
  return undefined;
}

function entryTreeLimitDiagnostic(
  limits: EntryDetail["files"]["limits"],
): string {
  const labels = limits.map((limit) => {
    switch (limit) {
      case "entries":
        return `${MAX_ENTRY_TREE_ENTRIES.toLocaleString()} entries`;
      case "depth":
        return `${MAX_ENTRY_TREE_DEPTH} levels`;
      case "metadata-bytes":
        return `${formatBytes(MAX_ENTRY_TREE_METADATA_BYTES)} of path metadata`;
    }
    return limit;
  });
  return `The file tree was truncated at ${labels.join(", ")}.`;
}

function isTextMimeType(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType?.startsWith("text/") ||
    mimeType?.startsWith("application/json") ||
    mimeType?.startsWith("application/x-ndjson"),
  );
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function DiagnosticRow({ diagnostic }: { diagnostic: EntryDiagnostic }) {
  return (
    <Item variant="outline" role="listitem" className="items-start">
      <ItemMedia variant="icon">
        <TriangleAlert />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>
          <span className="truncate">{diagnostic.folder}</span>
        </ItemTitle>
        <ItemDescription>{diagnostic.error}</ItemDescription>
        <ItemDescription>
          <code>{diagnostic.path}</code>
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/** A non-failure notice about the open entry: the reason IS the content. */
function EntryNote({ children }: { children: ReactNode }) {
  return (
    <Alert variant="warning" role="note" className="mt-2">
      <TriangleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
