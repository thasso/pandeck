import {
  Code2,
  Eye,
  ExternalLink,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  PlayCircle,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { documentTargetHref } from "@assistant/shared/documentTargets";
import { resolveInternalDocumentTarget } from "../lib/documentTargets.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import {
  formatFileSize,
  servedFileKind,
  servedFileName,
  type ServedFileKind,
} from "../lib/servedFiles.ts";
import { pushDocumentEntryAndAnnounce } from "../lib/historyNav.ts";
import {
  externalDocumentActionEnabled,
  runExternalDocumentAction,
} from "../lib/documentActions.ts";
import { ImageLightbox } from "./ui/ImageLightbox.tsx";

/**
 * One served file, as its producer described it: a captured `SessionArtifact`
 * and a `ShowFilesCardFile` both satisfy this shape. Only `url` decides
 * anything — source and kind are re-derived from it.
 */
interface ServedFile {
  url: string;
  name?: string;
  label?: string;
  /**
   * Only a CAPTURED artifact may set this, and only because its stored name may
   * carry no usable extension (a screenshot written by a tool), so the type the
   * capture recorded is the better answer. A `show_files` row deliberately omits
   * it: its address names a real file on disk, and letting a payload declare the
   * kind would let a crafted row present a Markdown file as a picture.
   */
  mimeType?: string;
  size?: number;
}

interface ServedFileCardProps {
  file: ServedFile;
}

const KIND_ICONS: Record<ServedFileKind, LucideIcon> = {
  image: ImageIcon,
  markdown: FileText,
  html: Code2,
  text: FileText,
  media: PlayCircle,
  other: FileIcon,
};

/**
 * @component ServedFileCard
 * @purpose Shows one structured tool-output file inline in chat, enlargeable for images and openable for everything else.
 * @useWhen Tool output supplies a served file — a captured `SessionArtifact` or a `show_files` card row; ordinary Markdown links and explicit image embeds use their own presentation.
 * @avoidWhen The file is user-uploaded context; use the attachment preview pattern instead.
 * @intent Browser-only preview loaded from the served URL, bounded in height, naming the file's real location and size so the reader knows what they are looking at. Clicking a picture opens the full-screen {@link ImageLightbox} rather than leaving the transcript — the chat surface is where the reader is.
 */
export function ServedFileCard({ file }: ServedFileCardProps) {
  const [enlarged, setEnlarged] = useState(false);
  const rawUrl = file.url;
  const url = artifactHttpUrl(rawUrl);
  const target = resolveInternalDocumentTarget(rawUrl);
  const path = target?.path ?? rawUrl;
  const name = file.name || servedFileName(path);
  const title = file.label || name || "Served file";
  const size = file.size === undefined ? "" : formatFileSize(file.size);
  const kind = servedFileKind(target ? target.path : "", file.mimeType);
  const Icon = KIND_ICONS[kind];
  const viewerHref = target ? documentTargetHref(target) : undefined;
  const externalEnabled = target ? externalDocumentActionEnabled(target) : true;

  if (!url) return null;

  return (
    <span className="not-prose my-2 block overflow-hidden rounded-xl border border-line bg-surface text-left text-fg shadow-sm">
      <span className="flex items-start justify-between gap-2 border-b border-line p-2.5">
        <span className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-primary">
            <Icon size={14} />
          </span>
          <span className="min-w-0">
            <span
              className="block truncate text-caption font-medium text-fg"
              title={title}
            >
              {title}
            </span>
            <span
              className="block truncate text-micro text-faint"
              title={path || name}
            >
              {path || name || "Served file"}
              {size ? ` · ${size}` : ""}
            </span>
            <span className="block truncate text-micro text-muted-foreground">
              Preview only · not added to assistant context
            </span>
          </span>
        </span>
        {viewerHref ? (
          <a
            href={viewerHref}
            onClick={(event) => {
              if (
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              pushDocumentEntryAndAnnounce(viewerHref);
            }}
            title="Open in the file viewer"
            aria-label="Open in the file viewer"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-raised hover:text-fg"
          >
            <Eye size={14} />
          </a>
        ) : null}
        {target ? (
          <button
            type="button"
            onClick={() =>
              void runExternalDocumentAction(
                target,
                kind === "other" ? "download" : "open",
              )
            }
            disabled={!externalEnabled}
            title={
              externalEnabled
                ? kind === "other"
                  ? "Download this file"
                  : "Open in a new window"
                : "External opening is unavailable for this source in the native app"
            }
            aria-label={
              kind === "other" ? "Download this file" : "Open in a new window"
            }
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
          >
            <ExternalLink size={14} />
          </button>
        ) : (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            title="Open external file"
            aria-label="Open external file"
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-raised hover:text-fg"
          >
            <ExternalLink size={14} />
          </a>
        )}
      </span>
      {kind === "image" ? (
        <>
          <button
            type="button"
            onClick={() => setEnlarged(true)}
            title="Click to enlarge"
            aria-label={`Enlarge ${title}`}
            className="block w-full cursor-zoom-in bg-panel"
          >
            <img
              src={url}
              alt={title}
              className="max-h-[32rem] w-full object-contain"
            />
          </button>
          {enlarged ? (
            <ImageLightbox
              src={url}
              alt={title}
              caption={name ?? title}
              onClose={() => setEnlarged(false)}
            />
          ) : null}
        </>
      ) : (
        <span className="block p-3 text-caption text-muted-foreground">
          {viewerHref ? VIEWER_COPY[kind] : NO_VIEWER_COPY[kind]}
        </span>
      )}
    </span>
  );
}

/** An internal source: its source-specific viewer renders it. */
const VIEWER_COPY: Record<ServedFileKind, string> = {
  image: "",
  markdown: "Open the viewer to read it rendered.",
  html: "Open the viewer to view it.",
  text: "Open the viewer to read it.",
  media: "Open the viewer to play it.",
  other: "No inline preview for this file type. Download it to inspect it.",
};

/**
 * An external/unresolved file has no internal viewer route; promise only the
 * header action.
 */
const NO_VIEWER_COPY: Record<ServedFileKind, string> = {
  image: "",
  markdown: "Open it in a new window to read it.",
  html: "Download it to open it in a browser.",
  text: "Open it in a new window to read it.",
  media: "Open it in a new window to play it.",
  other: "No inline preview for this file type. Download it to inspect it.",
};
