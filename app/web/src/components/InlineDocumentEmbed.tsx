import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Eye, Play } from "lucide-react";
import {
  documentTargetHref,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";
import { servedFileMediaElementOf } from "@assistant/shared/servedFiles";
import { mintFileGrantUrl, type FileGrantUrl } from "../lib/directFiles.ts";
import { documentTargetRawUrl } from "../lib/documentTargets.ts";
import { artifactHttpUrl } from "../lib/serverOrigin.ts";
import { servedFileKind } from "../lib/servedFiles.ts";
import { dataOf, errorOf, isInitialLoad } from "../lib/loadState.ts";
import { useFetchState } from "../hooks/useFetchState.ts";
import { pushDocumentEntryAndAnnounce } from "../lib/historyNav.ts";
import { SandboxedDocument } from "./SandboxedDocument.tsx";
import { ImageLightbox } from "./common/ImageLightbox.tsx";
import { ErrorNote, Skeleton } from "./common/load.tsx";

function targetPath(target: DocumentTarget): string {
  return target.path;
}

export const mediaElementForPath = servedFileMediaElementOf;

/** Renew before expiry; sleeping pages also re-check when the reader returns. */
const MEDIA_GRANT_RENEW_MARGIN_MS = 60_000;

function useVisible(): {
  ref: RefObject<HTMLSpanElement | null>;
  visible: boolean;
} {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, visible };
}

/** Explicit `![]()` presentation, deliberately distinct from artifact cards. */
export function InlineDocumentEmbed({
  target,
  label,
  insideLink = false,
}: {
  target: DocumentTarget;
  label?: string | undefined;
  /**
   * The embed sits inside an authored `[![…](…)](…)` link, which owns the
   * interaction: an image renders bare and every other source becomes that
   * link's text, so no control and no second anchor is nested in it.
   */
  insideLink?: boolean;
}) {
  const path = targetPath(target);
  const rawUrl = artifactHttpUrl(documentTargetRawUrl(target));
  const viewerHref = documentTargetHref(target);
  const kind = servedFileKind(path);
  const media = kind === "media" ? mediaElementForPath(path) : null;
  const html = kind === "html";
  const { ref, visible } = useVisible();

  if (kind === "image") {
    const image = (
      <img
        src={rawUrl}
        alt={label ?? ""}
        loading="lazy"
        className="max-h-[32rem] max-w-full object-contain"
      />
    );
    // Inside an authored link that anchor owns the click, so the picture stays
    // inert. Standing on its own it enlarges, like every other served image.
    if (insideLink) return image;
    return (
      <EnlargeableImage
        src={rawUrl}
        alt={label ?? ""}
        caption={path.split("/").pop() ?? path}
      >
        {image}
      </EnlargeableImage>
    );
  }

  if (insideLink) return <>{label ?? path.split("/").pop() ?? path}</>;

  if (!html && !media) {
    return <DocumentEmbedFallback href={viewerHref} label={label ?? path} />;
  }

  if (media) {
    return (
      <span ref={ref} className="not-prose my-2 block max-w-full">
        <DeferredGrantedMedia
          kind={media}
          target={target}
          label={label ?? path.split("/").pop() ?? "Media"}
        />
      </span>
    );
  }

  return (
    <span ref={ref} className="not-prose my-2 block max-w-full">
      <span className="block max-h-96 overflow-hidden rounded-lg border border-line bg-panel">
        {visible ? (
          <SandboxedDocument
            target={target}
            title={label ?? path}
            fallback={
              <DocumentEmbedFallback href={viewerHref} label={label ?? path} />
            }
          />
        ) : (
          <Skeleton className="block h-96" />
        )}
      </span>
      <a
        href={viewerHref}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
            return;
          event.preventDefault();
          pushDocumentEntryAndAnnounce(viewerHref);
        }}
        className="mt-1 inline-flex items-center gap-1 text-micro text-muted-foreground hover:text-fg"
      >
        <Eye size={12} /> Open in viewer
      </a>
    </span>
  );
}

/**
 * Click-to-enlarge around a bare embedded picture. The button carries no chrome
 * of its own — it is the image, at the size the flow gave it — and exists so the
 * enlarge step is reachable by keyboard and announced, exactly as it is from an
 * artifact card ({@link ImageLightbox}).
 */
function EnlargeableImage({
  src,
  alt,
  caption,
  children,
}: {
  src: string;
  alt: string;
  caption: string;
  children: ReactNode;
}) {
  const [enlarged, setEnlarged] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setEnlarged(true)}
        title="Click to enlarge"
        aria-label={`Enlarge ${alt || caption}`}
        className="inline-block max-w-full cursor-zoom-in align-middle"
      >
        {children}
      </button>
      {enlarged ? (
        <ImageLightbox
          src={src}
          alt={alt}
          caption={caption}
          onClose={() => setEnlarged(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Deferred, grant-backed playback. `generation` is the reload contract every
 * host surface shares: a bump means the bytes on disk are not the bytes this
 * player holds, so the granted player is DISCARDED — the reader is back at
 * Play, with no `src` and no request — and the next Play mints against the
 * file as it is now. The key is the whole implementation of that: it drops the
 * activation, the held grant, the resume position and any playback failure in
 * one move, which a hand-written reset of four pieces of state would not.
 */
export function DeferredGrantedMedia({
  generation = 0,
  ...props
}: {
  kind: "audio" | "video";
  target: DocumentTarget;
  label: string;
  generation?: number;
}) {
  return <GrantedMediaPlayer key={generation} {...props} />;
}

function GrantedMediaPlayer({
  kind,
  target,
  label,
}: {
  kind: "audio" | "video";
  target: DocumentTarget;
  label: string;
}) {
  const [activated, setActivated] = useState(false);
  const [mediaFailure, setMediaFailure] = useState<{
    url: string;
    message: string;
  } | null>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const resumeRef = useRef({ time: 0, playing: true });
  const freshRef = useRef(false);
  const key = activated ? documentTargetHref(target) : null;
  const { state, reload } = useFetchState<FileGrantUrl>(
    key,
    useCallback(
      (_key: string, signal: AbortSignal) => {
        const fresh = freshRef.current;
        freshRef.current = false;
        return mintFileGrantUrl(target, signal, "file", "inline", fresh);
      },
      [target],
    ),
  );
  const grant = dataOf(state);
  const error = errorOf(state);

  const capturePlayback = useCallback((preserveIntent = false) => {
    const media = mediaRef.current;
    if (!media) return;
    resumeRef.current = {
      time: Number.isFinite(media.currentTime) ? media.currentTime : 0,
      playing: preserveIntent
        ? resumeRef.current.playing
        : !media.paused && !media.ended,
    };
  }, []);
  const renew = useCallback(() => {
    if (state.status === "loading" || state.status === "refreshing") return;
    capturePlayback();
    freshRef.current = true;
    reload();
  }, [capturePlayback, reload, state.status]);

  useEffect(() => {
    if (!activated || !grant) return;
    const stale = () =>
      grant.expiresAt - Date.now() <= MEDIA_GRANT_RENEW_MARGIN_MS;
    const due = grant.expiresAt - Date.now() - MEDIA_GRANT_RENEW_MARGIN_MS;
    const timer = window.setTimeout(renew, Math.max(due, 1_000));
    const recheck = () => {
      if (stale()) renew();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [activated, grant, renew]);

  const grantUrl = grant?.url;
  useEffect(() => {
    if (grantUrl) setMediaFailure(null);
  }, [grantUrl]);

  if (!activated) {
    return (
      <button
        type="button"
        onClick={() => setActivated(true)}
        aria-label={`Play ${label}`}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-caption text-fg hover:bg-raised"
      >
        <Play size={16} /> Play {label}
      </button>
    );
  }
  if (error)
    return (
      <ErrorNote message={error} onRetry={renew} retryLabel="Retry media" />
    );
  if (isInitialLoad(state) || !grant)
    return (
      <Skeleton className={kind === "audio" ? "h-11 w-72" : "h-64 w-full"} />
    );
  if (mediaFailure?.url === grant.url)
    return (
      <ErrorNote
        message={mediaFailure.message}
        onRetry={renew}
        retryLabel="Retry media"
      />
    );

  const mediaProps = {
    key: grant.url,
    ref: (media: HTMLMediaElement | null) => {
      mediaRef.current = media;
    },
    src: grant.url,
    controls: true,
    autoPlay: resumeRef.current.playing,
    "aria-label": label,
    onPlay: () => {
      resumeRef.current.playing = true;
    },
    onPause: () => {
      const media = mediaRef.current;
      if (!media?.ended && !media?.error) resumeRef.current.playing = false;
    },
    onEnded: () => {
      resumeRef.current.playing = false;
    },
    onLoadedMetadata: () => {
      const media = mediaRef.current;
      if (!media) return;
      const position = resumeRef.current.time;
      if (position > 0) {
        try {
          media.currentTime = Number.isFinite(media.duration)
            ? Math.min(position, media.duration)
            : position;
        } catch {
          // Some streaming formats reject seeking before their range is ready.
        }
      }
      if (resumeRef.current.playing) void media.play().catch(() => undefined);
    },
    onError: () => {
      capturePlayback(true);
      setMediaFailure({
        url: grant.url,
        message: `Could not play ${label}. The media link may have expired.`,
      });
    },
  } as const;
  return kind === "audio" ? (
    <audio {...mediaProps} className="max-w-full" />
  ) : (
    <video
      {...mediaProps}
      // Without this iOS takes every video fullscreen the moment it plays,
      // which throws the reader out of the surface they pressed Play in.
      playsInline
      className="max-h-96 max-w-full rounded-lg bg-black"
    />
  );
}

function DocumentEmbedFallback({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <a
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        pushDocumentEntryAndAnnounce(href);
      }}
    >
      {label}
    </a>
  );
}
