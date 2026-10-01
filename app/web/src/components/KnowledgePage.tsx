import { useCallback, useEffect, type ReactNode } from "react";
import { BookOpen, FileText } from "lucide-react";
import type { PaObjectLinkResolution } from "@assistant/shared/objectLinks";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import type { KnowledgeEntryResponse } from "@assistant/shared/knowledgeBase";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { KnowledgeEntryViewer } from "./KnowledgeEntryViewer.tsx";
import { KnowledgeFileViewer } from "./KnowledgeFileViewer.tsx";
import { EmptyBox, ErrorNote, PaneLoading } from "./ui/load.tsx";
import {
  fetchKnowledgeEntry,
  fetchKnowledgeEntryByPath,
  knowledgeAssetUrl,
} from "../lib/knowledgeBaseApi.ts";
import { useFetchState, useReloadOnToken } from "../hooks/useFetchState.ts";
import { dataOf, errorOf, isInitialLoad } from "../lib/loadState.ts";
import { copyWithToast } from "../lib/clipboard.ts";

/**
 * @component KnowledgePage
 * @purpose Main-pane surface for the Knowledge routes: `/knowledge` introduces
 * the space, while `/knowledge/:entryId` loads and renders one entry as a
 * readable, linkable Markdown document via `KnowledgeEntryViewer`.
 * @useWhen Rendering canonical Knowledge routes in the main pane.
 * @avoidWhen Rendering the sidebar tree; use `KnowledgeBrowser` there.
 * @intent Container that owns entry fetching, asset URL signing, clipboard, and
 * navigation; the pure viewer owns document presentation.
 */
export function KnowledgePage({
  back,
  headerActions,
  failure,
  onDismissFailure,
  entryId,
  entryPath,
  filePath,
  assetPath,
  anchor,
  onOpenPaObject,
  onEntryLoaded,
  changedAtByEntryId,
}: {
  /** Mobile screen back control (ui-shell.md, Small Screens). */
  back?: PageHeaderBack | undefined;
  /** Host controls for the loaded entry's identity row (the side panel's "Open in Knowledge"). */
  headerActions?: ReactNode | undefined;
  /**
   * The failure the open entry is CARRYING (`docs/messaging.md`): a write about
   * the entry that no control here tracks, kept until this note's dismiss or
   * the entry's own next write.
   */
  failure?: string | undefined;
  onDismissFailure?: (() => void) | undefined;
  entryId?: string | null;
  entryPath?: string | null;
  /** Tree path of a non-entry file (asset/loose) to preview in the main pane. */
  filePath?: string | null;
  /** Entry-local asset preserving its Knowledge entry identity. */
  assetPath?: string | null;
  anchor?: DocumentLineAnchor | undefined;
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  /**
   * Report the loaded entry so the host can label its own controls for it, with
   * the ADDRESS the load was for — the entry path when the route named one, else
   * null. The host's copy of this outlives the route, so without the address it
   * cannot tell "entry A is open" from "A is still on screen while B loads".
   */
  onEntryLoaded?: (
    entryId: string,
    title: string,
    addressedPath: string | null,
  ) => void;
  changedAtByEntryId?: Record<string, number> | undefined;
}) {
  if (filePath || (entryId && assetPath)) {
    const path = filePath ?? assetPath!;
    return (
      <KnowledgeFileViewer
        key={`${entryId && assetPath ? `asset:${entryId}:` : "file:"}${path}`}
        path={path}
        entryId={entryId && assetPath ? entryId : undefined}
        anchor={anchor}
      />
    );
  }
  const ref = entryId
    ? { id: entryId }
    : entryPath
      ? { path: entryPath }
      : null;
  if (!ref) return <KnowledgeIntro back={back} />;
  // The loader addresses the entry through its FETCH key (R3), so switching
  // routes drops the previous document during render rather than needing a
  // remount to stop it appearing (or resolving its assets) under a new URL.
  return (
    <KnowledgeEntryLoader
      back={back}
      headerActions={headerActions}
      failure={failure}
      onDismissFailure={onDismissFailure}
      target={ref}
      onOpenPaObject={onOpenPaObject}
      onEntryLoaded={onEntryLoaded}
      changedAtByEntryId={changedAtByEntryId}
    />
  );
}

function KnowledgeEntryLoader({
  back,
  headerActions,
  failure,
  onDismissFailure,
  target,
  onOpenPaObject,
  onEntryLoaded,
  changedAtByEntryId,
}: {
  back?: PageHeaderBack | undefined;
  headerActions?: ReactNode | undefined;
  failure?: string | undefined;
  onDismissFailure?: (() => void) | undefined;
  target: { id: string } | { path: string };
  onOpenPaObject?: ((link: PaObjectLinkResolution) => void) | undefined;
  /**
   * Report the loaded entry so the host can label its own controls for it, with
   * the ADDRESS the load was for — the entry path when the route named one, else
   * null. The host's copy of this outlives the route, so without the address it
   * cannot tell "entry A is open" from "A is still on screen while B loads".
   */
  onEntryLoaded?:
    | ((entryId: string, title: string, addressedPath: string | null) => void)
    | undefined;
  changedAtByEntryId?: Record<string, number> | undefined;
}) {
  // The addressed entry IS the fetch key: entry → entry navigation drops the
  // previous document with no frame under the new URL (R3).
  const key = entryFetchKey(target);
  const { state, reload } = useFetchState(key, fetchEntryForKey);
  const resource = dataOf(state) ?? null;
  const error = errorOf(state);

  // A committed change to THIS entry is a refresh of the SAME key, so the
  // document stays on screen while it refetches (R2), and a freshly addressed
  // entry does not refetch itself just because it carries a token.
  useReloadOnToken(
    key,
    "id" in target ? (changedAtByEntryId?.[target.id] ?? 0) : 0,
    reload,
  );

  // Assets resolve against the loaded entry's real id, never the route param.
  const resolveAssetUrl = useCallback(
    (assetPath: string) =>
      knowledgeAssetUrl(
        resource?.kind === "entry" ? resource.id : "",
        assetPath,
      ),
    [resource],
  );
  const onCopyLink = useCallback((uri: string, copyLabel: string) => {
    void copyWithToast(uri, {
      successMessage: `Copied link to “${copyLabel}”`,
    });
  }, []);

  const loadedEntry = resource?.kind === "entry" ? resource : null;
  const loadedEntryId = loadedEntry?.id ?? null;
  const loadedEntryTitle = loadedEntry?.title ?? null;
  // The address is part of what is reported, so a same-entry re-address has to
  // re-report it rather than leaving the host correlating against the old one.
  const addressedPath = "path" in target ? target.path : null;
  // The REPORT, separately: the host (App) labels the dock's actions for this
  // entry, and only the loaded document knows its title — so a rename re-reports
  // it, which is a cheap call and touches no subscription.
  useEffect(() => {
    if (loadedEntryId === null || loadedEntryTitle === null) return;
    onEntryLoaded?.(loadedEntryId, loadedEntryTitle, addressedPath);
  }, [loadedEntryId, loadedEntryTitle, addressedPath, onEntryLoaded]);

  // The entry's OWN failure, drawn in every state below: a write about the entry
  // can be refused while its document is still loading or cannot be read at all,
  // and a note only the loaded branch draws would be claimed by this surface
  // (`FailureHomes.openObjects`) and then shown by nothing.
  const failureNote = failure ? (
    <ErrorNote
      message={failure}
      onRetry={onDismissFailure}
      retryLabel="Dismiss"
    />
  ) : null;

  // A full reload has no document yet. Keep the pane to its loading indicator:
  // a page header belongs to the readable entry and must not arrive early with
  // a placeholder title before the document does.
  if (isInitialLoad(state)) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface">
        <div className="flex w-full flex-col gap-3">
          {failureNote}
          <PaneLoading label="Loading entry…" />
        </div>
      </div>
    );
  }
  if (!resource) {
    return (
      <KnowledgeShell back={back}>
        <div className="flex w-full max-w-md flex-col gap-3">
          {/* The reason belongs to the note below, which also carries the retry;
              this only says what the route was pointing at. */}
          <KnowledgeNotice
            icon={<FileText size={22} />}
            title="Entry not available"
            detail="It may have been moved, removed, or is not indexed yet."
          />
          {error ? <ErrorNote message={error} onRetry={reload} /> : null}
          {failureNote}
        </div>
      </KnowledgeShell>
    );
  }
  // R2: a refresh that failed keeps the document it already has and says so
  // above it, rather than replacing a readable entry with an error page. The
  // frame is UNCONDITIONAL: making it appear with the note would change the
  // element type at the viewer's position, and React would remount the document
  // — throwing away the reading position and every draft in it at exactly the
  // moment R2 exists to protect them.
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {error ? (
        <div className="shrink-0 px-4 pt-3">
          <ErrorNote
            message={`Could not refresh this entry: ${error}`}
            onRetry={reload}
          />
        </div>
      ) : null}
      {/* Beside the refresh failure above it, and a sibling slot rather than a
          wrapper for the same reason: an element appearing AT the viewer's own
          position would remount the document. */}
      {failure ? <div className="shrink-0 px-4 pt-3">{failureNote}</div> : null}
      <div className="min-h-0 flex-1">
        <KnowledgeEntryViewer
          back={back}
          headerActions={headerActions}
          resource={resource}
          resolveAssetUrl={resolveAssetUrl}
          onOpenPaObject={onOpenPaObject}
          onCopyLink={onCopyLink}
          refreshing={state.status === "refreshing"}
        />
      </div>
    </div>
  );
}

/** The fetch key IS the address: `id:<entry id>` or `path:<entry folder>`. */
function entryFetchKey(target: { id: string } | { path: string }): string {
  return "id" in target ? `id:${target.id}` : `path:${target.path}`;
}

function fetchEntryForKey(key: string): Promise<KnowledgeEntryResponse> {
  return key.startsWith("id:")
    ? fetchKnowledgeEntry(key.slice("id:".length))
    : fetchKnowledgeEntryByPath(key.slice("path:".length));
}

function KnowledgeIntro({ back }: { back?: PageHeaderBack | undefined }) {
  return (
    <KnowledgeShell back={back}>
      <KnowledgeNotice
        icon={<FileText size={22} />}
        title="Knowledge Base"
        detail="Use the Knowledge sidebar section to browse the compact KB tree, then open an entry to read it here. Generated implementation files are intentionally hidden from the normal tree."
      />
    </KnowledgeShell>
  );
}

/**
 * The Knowledge route's chrome around a state that is not a document: the same
 * header the viewer draws, with the state centred in the reading column.
 */
function KnowledgeShell({
  back,
  children,
}: {
  back?: PageHeaderBack | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PageHeader
        back={back}
        icon={<BookOpen size={16} />}
        iconTone="accent"
        density="compact"
        title="Knowledge"
      />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-center">
          {children}
        </div>
      </main>
    </div>
  );
}

/** "There is no document here" — the intro, and the entry that did not resolve. */
function KnowledgeNotice({
  icon,
  title,
  detail,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <EmptyBox className="w-full max-w-md bg-panel/60">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
        {icon}
      </div>
      <h1 className="text-prose font-semibold text-fg">{title}</h1>
      {detail ? <p className="mt-2 text-body text-muted">{detail}</p> : null}
    </EmptyBox>
  );
}
