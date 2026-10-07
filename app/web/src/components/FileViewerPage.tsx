import { useCallback, useMemo, useRef, useState } from "react";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import {
  Code2,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  PlayCircle,
  RefreshCw,
} from "lucide-react";
import {
  fetchDirectFileMeta,
  fetchDirectFileText,
  type DirectFileMeta,
  type DirectFileText,
} from "../lib/directFiles.ts";
import { pdfZoomMode } from "../lib/embeddedPdf.ts";
import type { DocumentZoomMode } from "../lib/documentZoom.ts";
import { dataOf, errorOf, isInitialLoad } from "../lib/loadState.ts";
import { runExternalDocumentAction } from "../lib/documentActions.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import {
  directFileApiPath,
  formatFileSize,
  servedFileKind,
  type ServedFileKind,
} from "../lib/servedFiles.ts";
import { useFetchState } from "../hooks/useFetchState.ts";
import { MarkdownFile } from "./MarkdownFile.tsx";
import {
  DocumentAnchorRegion,
  DocumentRangeNotice,
} from "./DocumentAnchorRegion.tsx";
import { DocumentTextBody } from "./DocumentTextBody.tsx";
import { DocumentNavigationShell } from "./DocumentNavigationShell.tsx";
import { DocumentCommentLayer } from "./DocumentComments.tsx";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import { SandboxedDocument } from "./SandboxedDocument.tsx";
import {
  DeferredGrantedMedia,
  mediaElementForPath,
} from "./InlineDocumentEmbed.tsx";

const KIND_ICONS = {
  image: ImageIcon,
  markdown: FileText,
  html: Code2,
  text: FileText,
  media: PlayCircle,
  other: FileIcon,
} as const;

/**
 * @component FileViewerPage
 * @purpose Full-pane viewer for ONE file on the host, addressed by absolute path: Markdown rendered, HTML run in a sandbox, text read as text, images shown, anything else offered as a download.
 * @useWhen The reader followed a `/files/...` link — from a chat card, or an agent's inline Markdown link to a file it wrote.
 * @avoidWhen The content is a Knowledge Base entry or a worktree diff; those have their own surfaces with their own history and comments.
 * @intent The file is LIVE, not a snapshot: the header states where it is on disk and offers a reload, and a document that has changed or vanished says so instead of showing stale bytes. HTML never runs on the app origin — {@link SandboxedDocument} serves it from a directory-scoped grant. Comments collect in the file's tray ({@link DocumentCommentLayer}): on a passage of Markdown or text, on the whole file for everything else.
 */
export function FileViewerPage({
  path,
  anchor,
}: {
  path: string;
  anchor?: DocumentLineAnchor | undefined;
}) {
  const kind = servedFileKind(path);
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const Icon = KIND_ICONS[kind];
  const target = useMemo(
    () => ({ kind: "hostFile" as const, path, ...(anchor ? { anchor } : {}) }),
    [anchor, path],
  );

  const { state: metaState, reload: reloadMeta } =
    useFetchState<DirectFileMeta>(
      path,
      useCallback(
        (key: string, signal: AbortSignal) => fetchDirectFileMeta(key, signal),
        [],
      ),
    );
  const meta = dataOf(metaState);
  const metaError = errorOf(metaState);

  // Text bodies are fetched only for the kinds that render as text. HTML is
  // never read into the app: it is served to the sandbox as a document.
  const textKey = kind === "markdown" || kind === "text" ? path : null;
  const { state: textState, reload: reloadText } =
    useFetchState<DirectFileText>(
      textKey,
      useCallback(
        (key: string, signal: AbortSignal) => fetchDirectFileText(key, signal),
        [],
      ),
    );
  const body = dataOf(textState);
  const bodyError = errorOf(textState);
  // The rendered text a passage comment is selected in: Markdown and text only.
  // Everything else — an image, a PDF, sandboxed HTML — takes comments on the
  // whole file.
  const textRoot = useRef<HTMLDivElement | null>(null);
  const [textRootVersion, setTextRootVersion] = useState(0);
  const attachTextRoot = useCallback((node: HTMLDivElement | null) => {
    textRoot.current = node;
    if (node) setTextRootVersion((version) => version + 1);
  }, []);
  const commentDocument = useMemo(
    () => ({ kind: "hostFile" as const, path }),
    [path],
  );
  const lineSource =
    kind === "markdown" ? "markdown" : kind === "text" ? "code" : undefined;

  // Bumped by Reload: it re-keys the image/media `src` and the sandboxed
  // document's grant, which a metadata refetch alone would not touch — the
  // browser would keep showing its cached copy of a file that changed on disk.
  const [generation, setGeneration] = useState(0);
  const rawUrl = useMemo(
    () => artifactHttpUrl(directFileApiPath(path)),
    [path],
  );
  const versionedUrl = `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}v=${generation}`;
  const reload = useCallback(() => {
    reloadMeta();
    reloadText();
    setGeneration((previous) => previous + 1);
  }, [reloadMeta, reloadText]);
  const sourceActions = useMemo(
    () => [
      {
        id: "reload",
        label: "Reload from disk",
        icon: <RefreshCw size={16} />,
        onRun: reload,
      },
      {
        id: "download",
        label: "Download this file",
        icon: <Download size={16} />,
        onRun: () => void runExternalDocumentAction(target, "download"),
      },
      {
        id: "raw",
        label: "Open the raw file",
        icon: <ExternalLink size={16} />,
        onRun: () => void runExternalDocumentAction(target, "open"),
      },
    ],
    [reload, target],
  );

  return (
    <DocumentNavigationShell
      target={target}
      icon={<Icon size={16} />}
      title={name}
      subtitle={
        <span className="flex items-center gap-2">
          <span className="truncate" title={path}>
            {path}
          </span>
          {meta ? (
            <span className="shrink-0 text-faint">
              {formatFileSize(meta.sizeBytes)} ·{" "}
              {new Date(meta.modifiedMs).toLocaleString()}
            </span>
          ) : null}
        </span>
      }
      actions={
        <>
          {metaState.status === "refreshing" ||
          textState.status === "refreshing" ? (
            <RefreshIndicator label="Reloading this file" />
          ) : null}
        </>
      }
      sourceActions={sourceActions}
      zoomMode={viewerZoomMode(kind, path)}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div data-document-scroll className="min-h-0 flex-1 overflow-auto">
          {metaError ? (
            <div className="p-4">
              <ErrorNote message={metaError} onRetry={reload} />
            </div>
          ) : isInitialLoad(metaState) ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <ViewerBody
              kind={kind}
              target={target}
              path={path}
              anchor={anchor}
              name={name}
              sizeBytes={meta?.sizeBytes}
              versionedUrl={versionedUrl}
              generation={generation}
              body={body}
              bodyError={bodyError}
              onRetry={reload}
              textRootRef={attachTextRoot}
            />
          )}
        </div>
        <DocumentCommentLayer
          document={commentDocument}
          {...(lineSource
            ? { rootRef: textRoot, lineSource, rootVersion: textRootVersion }
            : {})}
        />
      </div>
    </DocumentNavigationShell>
  );
}

/**
 * The zoom this viewer answers to, decided by the renderer on screen. A PDF is
 * the one `media` file that is not a player: a document where the engine frames
 * it, and the open-in-your-browser panel — which scales nothing — where it
 * cannot (`../lib/embeddedPdf.ts`).
 */
function viewerZoomMode(
  kind: ServedFileKind,
  path: string,
): DocumentZoomMode | null {
  if (kind === "media" && !mediaElementForPath(path)) return pdfZoomMode();
  if (kind === "image" || kind === "html" || kind === "media") return "visual";
  return kind === "other" ? null : "text";
}

function ViewerBody({
  kind,
  target,
  path,
  anchor,
  name,
  sizeBytes,
  versionedUrl,
  generation,
  body,
  bodyError,
  onRetry,
  textRootRef,
}: {
  kind: ServedFileKind;
  target: { kind: "hostFile"; path: string; anchor?: DocumentLineAnchor };
  path: string;
  anchor?: DocumentLineAnchor | undefined;
  name: string;
  /** Known once the file's metadata has answered; the PDF panel states it. */
  sizeBytes?: number | undefined;
  /** Same file, re-fetched after a reload rather than served from the cache. */
  versionedUrl: string;
  generation: number;
  body: DirectFileText | undefined;
  bodyError: string | undefined;
  onRetry: () => void;
  /** The element holding the rendered text, for passage comments. */
  textRootRef: (node: HTMLDivElement | null) => void;
}) {
  const documentDirectory = path.split("/").slice(0, -1).join("/");
  if (kind === "html") {
    return (
      <SandboxedDocument
        target={target}
        generation={generation}
        // The reader opened this surface to look at the document, so it gets
        // the height — and the way OUT to a real browser tab, which is the one
        // thing the header cannot offer for HTML: its raw link would download.
        showOpenAction
        className="document-visual-content h-full w-full"
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="document-visual-content flex h-full items-center justify-center bg-panel p-4">
        <img src={versionedUrl} alt={name} className="max-h-full max-w-full" />
      </div>
    );
  }
  if (kind === "media") {
    const player = mediaElementForPath(path);
    if (player)
      return (
        <div className="document-visual-content flex min-h-full items-center justify-center p-4">
          {/* The one granted player every surface shares, so its `playsInline`
              video and grant handling are the same here as in a transcript.
              Reload discards it: back to Play, no request until the reader
              asks for the file again. */}
          <DeferredGrantedMedia
            kind={player}
            target={target}
            label={name}
            generation={generation}
          />
        </div>
      );
    // PDF uses the browser renderer, but the frame still receives only a
    // source-scoped, token-free file grant — re-minted on reload like the rest.
    return (
      <SandboxedDocument
        target={target}
        generation={generation}
        scope="file"
        contentPolicy="passive-pdf"
        sizeBytes={sizeBytes}
        className="document-visual-content h-full w-full"
      />
    );
  }
  if (kind === "other") {
    return (
      <div className="p-4">
        <EmptyBox>
          Nothing here renders this file type. Use Download in the document
          actions to open it in the appropriate app.
        </EmptyBox>
      </div>
    );
  }
  if (bodyError) {
    return (
      <div className="p-4">
        <ErrorNote message={bodyError} onRetry={onRetry} />
      </div>
    );
  }
  if (!body) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  const truncatedNote = body.truncated ? (
    <p className="mb-3 rounded-lg border border-line bg-panel p-2 text-caption text-muted-foreground">
      Showing the first part of this file only — download it to read the rest.
    </p>
  ) : null;
  if (kind === "markdown") {
    return (
      <DocumentAnchorRegion anchor={anchor} className="p-4">
        {truncatedNote}
        {/* Markdown is addressed by SOURCE line but rendered as blocks, so the
            anchor marks the blocks the bounded range falls in and the notice
            carries the rest of the story. */}
        <DocumentRangeNotice anchor={anchor} className="mb-3" />
        {/* Relative references inside the document resolve against its own
            directory, so an image beside the Markdown file renders. */}
        <div ref={textRootRef}>
          <MarkdownFile
            text={body.text}
            documentDirectory={documentDirectory}
            documentTarget={{ kind: "hostFile", path }}
            // Also what names a comment's source lines.
            sourcePositions
          />
        </div>
      </DocumentAnchorRegion>
    );
  }
  return (
    <div className="p-4">
      {truncatedNote}
      <div ref={textRootRef}>
        <DocumentTextBody text={body.text} name={name} anchor={anchor} />
      </div>
    </div>
  );
}
