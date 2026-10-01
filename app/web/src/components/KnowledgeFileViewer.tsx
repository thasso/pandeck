import { useCallback, useMemo } from "react";
import { BookOpen, Download, ExternalLink, FileText } from "lucide-react";
import type {
  DocumentLineAnchor,
  DocumentTarget,
} from "@assistant/shared/documentTargets";
import { servedFileKindOf } from "@assistant/shared/servedFiles";
import {
  fetchKnowledgeFileText,
  knowledgeAssetUrl,
  knowledgeFileUrl,
} from "../lib/knowledgeBaseApi.ts";
import { useFetchState } from "../hooks/useFetchState.ts";
import {
  externalDocumentActionEnabled,
  runExternalDocumentAction,
} from "../lib/documentActions.ts";
import { pdfZoomMode } from "../lib/embeddedPdf.ts";
import { dataOf, errorOf, isInitialLoad } from "../lib/loadState.ts";
import { EmptyBox, ErrorNote, PaneLoading } from "./ui/load.tsx";
import { DocumentTextBody } from "./DocumentTextBody.tsx";
import { DocumentNavigationShell } from "./DocumentNavigationShell.tsx";
import { SandboxedDocument } from "./SandboxedDocument.tsx";
import {
  DeferredGrantedMedia,
  mediaElementForPath,
} from "./InlineDocumentEmbed.tsx";

/**
 * @component KnowledgeFileViewer
 * @purpose Main-pane viewer for a non-entry KB file (an entry asset or a loose
 * file) addressed by its tree path: images inline, PDFs embedded where the
 * engine scrolls a framed one and otherwise in a panel that opens the file in a
 * browser tab, and text
 * files (JSON/YAML/CSV/etc.) syntax-highlighted, with a raw/download fallback
 * for anything else.
 * @useWhen The Knowledge route addresses a file (`/knowledge/~file/:path`).
 * @avoidWhen Rendering a readable KB entry document; use `KnowledgeEntryViewer`.
 */
export function KnowledgeFileViewer({
  path,
  entryId,
  anchor,
}: {
  path: string;
  /** Present for an entry-local asset addressed by pa://knowledge/<id>?asset=. */
  entryId?: string | undefined;
  anchor?: DocumentLineAnchor | undefined;
}) {
  const name = lastSegment(path);
  const kind = classifyFile(path);
  const rawUrl = entryId
    ? knowledgeAssetUrl(entryId, path)
    : knowledgeFileUrl(path);
  const target = useMemo(
    () =>
      entryId
        ? ({
            kind: "knowledgeAsset" as const,
            entryId,
            path,
            ...(anchor ? { anchor } : {}),
          } as const)
        : ({
            kind: "knowledgeFile" as const,
            path,
            ...(anchor ? { anchor } : {}),
          } as const),
    [anchor, entryId, path],
  );
  const sourceActions = useMemo(
    () => [
      {
        id: "open",
        label: "Open raw file",
        icon: <ExternalLink size={15} />,
        onRun: () => void runExternalDocumentAction(target, "open"),
      },
      {
        id: "download",
        label: "Download file",
        icon: <Download size={15} />,
        onRun: () => void runExternalDocumentAction(target, "download"),
      },
    ],
    [target],
  );

  return (
    <DocumentNavigationShell
      target={target}
      icon={<BookOpen size={16} />}
      iconTone="accent"
      title={name}
      subtitle={path}
      sourceActions={sourceActions}
      zoomMode={
        // A PDF the engine cannot frame is shown as a panel, which has nothing
        // for the zoom controls to scale (`../lib/embeddedPdf.ts`).
        kind === "pdf"
          ? pdfZoomMode()
          : kind === "image" || kind === "html" || kind === "media"
            ? "visual"
            : kind === "other"
              ? null
              : "text"
      }
    >
      <main data-document-scroll className="h-full min-h-0 overflow-y-auto">
        {kind === "image" ? (
          <div className="document-visual-content flex min-h-full items-center justify-center p-4">
            <img
              src={rawUrl}
              alt={name}
              className="max-h-full max-w-full rounded-lg border border-line bg-panel object-contain"
            />
          </div>
        ) : kind === "html" ? (
          <SandboxedDocument
            target={target}
            showOpenAction
            className="document-visual-content h-full w-full"
          />
        ) : kind === "pdf" ? (
          <SandboxedDocument
            target={target}
            scope="file"
            contentPolicy="passive-pdf"
            className="document-visual-content h-full w-full"
          />
        ) : kind === "media" ? (
          <div className="document-visual-content flex min-h-full items-center justify-center p-4">
            <DeferredGrantedMedia
              kind={mediaElementForPath(path) ?? "audio"}
              target={target}
              label={name}
            />
          </div>
        ) : kind === "text" ? (
          <div className="mx-auto w-full max-w-4xl px-4 py-4">
            <TextFile
              path={path}
              anchor={anchor}
              {...(entryId ? { rawUrl } : {})}
            />
          </div>
        ) : (
          <UnsupportedFile name={name} target={target} />
        )}
      </main>
    </DocumentNavigationShell>
  );
}

function TextFile({
  path,
  rawUrl,
  anchor,
}: {
  path: string;
  rawUrl?: string | undefined;
  anchor?: DocumentLineAnchor | undefined;
}) {
  const fetchText = useCallback(
    (key: string, signal: AbortSignal) =>
      rawUrl
        ? fetch(key, { signal }).then((response) => {
            if (!response.ok)
              throw new Error(`Could not load file (${response.status}).`);
            return response.text();
          })
        : fetchKnowledgeFileText(key),
    [rawUrl],
  );
  // The source address is the fetch key, so another file never renders under this one.
  const { state, reload } = useFetchState(rawUrl ?? path, fetchText);
  const text = dataOf(state);
  const error = errorOf(state);

  if (isInitialLoad(state)) return <PaneLoading label="Loading file…" />;
  if (text === undefined) {
    return (
      <ErrorNote
        message={`Could not load file: ${error ?? "not loaded"}`}
        onRetry={reload}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {/* R2: a failed re-read keeps the text that is already on screen. */}
      {error ? (
        <ErrorNote
          message={`Could not reload file: ${error}`}
          onRetry={reload}
        />
      ) : null}
      <DocumentTextBody text={text} name={lastSegment(path)} anchor={anchor} />
    </div>
  );
}

function UnsupportedFile({
  name,
  target,
}: {
  name: string;
  target: DocumentTarget;
}) {
  const enabled = externalDocumentActionEnabled(target);
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <EmptyBox
        className="w-full max-w-md bg-panel/60"
        action={
          <button
            type="button"
            onClick={() => void runExternalDocumentAction(target, "download")}
            disabled={!enabled}
            title={
              enabled
                ? "Download file"
                : "External download is unavailable in the native app"
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-accent-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download size={13} /> Download
          </button>
        }
      >
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <FileText size={22} />
        </div>
        <h1 className="text-prose font-semibold text-fg">{name}</h1>
        <p className="mt-2 text-body text-muted">
          This file type can't be previewed here. Open it raw or download it
          instead.
        </p>
      </EmptyBox>
    </div>
  );
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "csv",
  "tsv",
  "xml",
  "toml",
  "ini",
  "log",
  "css",
  "js",
  "ts",
  "tsx",
  "jsx",
  "sh",
  "bash",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "sql",
  "env",
  "conf",
  "cfg",
  "properties",
  "gitignore",
  "dockerfile",
]);

type FileKind = "image" | "html" | "pdf" | "media" | "text" | "other";

function classifyFile(path: string): FileKind {
  const sharedKind = servedFileKindOf(path);
  if (sharedKind === "image") return "image";
  if (sharedKind === "html") return "html";
  if (sharedKind === "media")
    return extensionOf(path) === "pdf" ? "pdf" : "media";
  if (sharedKind === "markdown" || sharedKind === "text") return "text";
  // Knowledge also renders a few conventional text names/extensions that the
  // general host-file contract deliberately treats as unknown.
  return TEXT_EXTENSIONS.has(extensionOf(path)) ? "text" : "other";
}

function extensionOf(path: string): string {
  const name = lastSegment(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function lastSegment(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}
