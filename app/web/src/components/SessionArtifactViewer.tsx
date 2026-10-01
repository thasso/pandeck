import { useCallback, useMemo, useState } from "react";
import { Download, ExternalLink, FileText } from "lucide-react";
import type { DocumentLineAnchor } from "@assistant/shared/documentTargets";
import { useFetchState } from "../hooks/useFetchState.ts";
import { pdfZoomMode } from "../lib/embeddedPdf.ts";
import { dataOf, errorOf, isInitialLoad } from "../lib/loadState.ts";
import { runExternalDocumentAction } from "../lib/documentActions.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { servedFileKind } from "../lib/servedFiles.ts";
import {
  DocumentAnchorRegion,
  DocumentRangeNotice,
} from "./DocumentAnchorRegion.tsx";
import { DocumentTextBody } from "./DocumentTextBody.tsx";
import { DocumentNavigationShell } from "./DocumentNavigationShell.tsx";
import { Markdown } from "./Markdown.tsx";
import { EmptyBox, ErrorNote, Skeleton } from "./ui/load.tsx";
import { SandboxedDocument } from "./SandboxedDocument.tsx";
import { DeferredGrantedMedia } from "./InlineDocumentEmbed.tsx";

export function SessionArtifactViewer({
  sessionId,
  path,
  anchor,
}: {
  sessionId: string;
  path: string;
  anchor?: DocumentLineAnchor | undefined;
}) {
  const name = path.split("/").pop() ?? path;
  const kind = servedFileKind(path);
  const player = kind === "media" ? artifactPlayer(name) : null;
  const target = useMemo(
    () => ({
      kind: "sessionArtifact" as const,
      sessionId,
      path,
      ...(anchor ? { anchor } : {}),
    }),
    [anchor, path, sessionId],
  );
  const sourceActions = useMemo(
    () => [
      {
        id: "open",
        label: "Open raw artifact",
        icon: <ExternalLink size={16} />,
        onRun: () => void runExternalDocumentAction(target, "open"),
      },
      {
        id: "download",
        label: "Download artifact",
        icon: <Download size={16} />,
        onRun: () => void runExternalDocumentAction(target, "download"),
      },
    ],
    [target],
  );
  const apiPath = `/api/session-artifacts/${encodeURIComponent(sessionId)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const rawUrl = artifactHttpUrl(apiPath);
  const textKey = kind === "markdown" || kind === "text" ? rawUrl : null;
  const { state, reload } = useFetchState(
    textKey,
    useCallback(async (url: string, signal: AbortSignal) => {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new Error(`Could not load artifact (${response.status}).`);
      return response.text();
    }, []),
  );
  const text = dataOf(state);
  const error = errorOf(state);
  return (
    <DocumentNavigationShell
      target={target}
      title={name}
      subtitle={`Captured in session ${sessionId}`}
      icon={<FileText size={16} />}
      sourceActions={sourceActions}
      zoomMode={
        // The `media` that is not a player is a PDF, and a PDF the engine
        // cannot frame becomes a panel with nothing to scale
        // (`../lib/embeddedPdf.ts`).
        kind === "media" && !player
          ? pdfZoomMode()
          : kind === "image" || kind === "html" || kind === "media"
            ? "visual"
            : kind === "other"
              ? null
              : "text"
      }
    >
      <div data-document-scroll className="h-full min-h-0 overflow-auto">
        {kind === "image" ? (
          <ArtifactImage rawUrl={rawUrl} name={name} />
        ) : player ? (
          <div className="document-visual-content flex min-h-full items-center justify-center p-4">
            <DeferredGrantedMedia kind={player} target={target} label={name} />
          </div>
        ) : kind === "html" ? (
          <SandboxedDocument
            target={target}
            showOpenAction
            className="document-visual-content h-full w-full"
          />
        ) : kind === "media" ? (
          <SandboxedDocument
            target={target}
            scope="file"
            contentPolicy="passive-pdf"
            className="document-visual-content h-full w-full"
          />
        ) : kind === "other" ? (
          <div className="p-4">
            <EmptyBox>
              This captured file can't be previewed here. Use Open or Download.
            </EmptyBox>
          </div>
        ) : error ? (
          <div className="p-4">
            <ErrorNote message={error} onRetry={reload} />
          </div>
        ) : isInitialLoad(state) || text === undefined ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : kind === "markdown" ? (
          <DocumentAnchorRegion anchor={anchor} className="p-4">
            {/* Markdown is addressed by source line and rendered as blocks:
                the bounded range marks the blocks it falls in. */}
            <DocumentRangeNotice anchor={anchor} className="mb-3" />
            <Markdown
              text={text}
              sourcePositions={Boolean(anchor)}
              documentTarget={{ kind: "sessionArtifact", sessionId, path }}
            />
          </DocumentAnchorRegion>
        ) : (
          <div className="p-4">
            <DocumentTextBody text={text} name={name} anchor={anchor} />
          </div>
        )}
      </div>
    </DocumentNavigationShell>
  );
}

/** The element that can PLAY a captured media file, if any. A PDF has none. */
function artifactPlayer(name: string): "audio" | "video" | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(extension))
    return "audio";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(extension)) return "video";
  return null;
}

function ArtifactImage({ rawUrl, name }: { rawUrl: string; name: string }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  if (failure)
    return (
      <div className="p-4">
        <ErrorNote
          message={failure}
          onRetry={() => {
            setFailure(null);
            setGeneration((value) => value + 1);
          }}
          retryLabel="Retry preview"
        />
      </div>
    );
  return (
    <div className="document-visual-content flex min-h-full items-center justify-center bg-panel p-4">
      <img
        key={generation}
        src={rawUrl}
        alt={`Captured artifact: ${name}`}
        onError={() => setFailure("Could not load the captured image.")}
        className="max-h-full max-w-full"
      />
    </div>
  );
}
