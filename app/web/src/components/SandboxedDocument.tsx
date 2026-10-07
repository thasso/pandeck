import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ExternalLink, FileText } from "lucide-react";
import {
  documentTargetHref,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";
import { mintFileGrantUrl, type FileGrantUrl } from "../lib/directFiles.ts";
import { embeddedPdfScrolls } from "../lib/embeddedPdf.ts";
import { formatFileSize } from "../lib/servedFiles.ts";
import { dataOf, errorOf } from "../lib/loadState.ts";
import {
  opensServedFileInNativeBrowser,
  openNativeServedFile,
} from "../lib/nativeShell.ts";
import { useFetchState } from "../hooks/useFetchState.ts";
import { EmptyBox, ErrorNote, Skeleton } from "./common/load.tsx";

/** Renew this far before expiry, so a reader never meets a dead frame. */
const RENEW_MARGIN_MS = 60_000;

/**
 * @component SandboxedDocument
 * @purpose Hosts a grant-backed browser document: opaque active HTML, or passive file-scoped PDF through the built-in viewer.
 * @useWhen Showing internal `.html` or `.pdf` content without putting the app token in a frame URL.
 * @avoidWhen The content is app-owned markup; render components instead. Never point this at untrusted markup you would not also open in a browser tab.
 * @intent Active HTML uses a directory grant plus `sandbox` WITHOUT `allow-same-origin`; passive PDF uses a one-file grant and no plugin-blocking sandbox. Neither frame URL carries the app token. `Open in a new tab` hands the same grant URL to a real browser tab. Where the engine cannot scroll a framed PDF (iOS/iPadOS WebKit), that tab replaces the frame entirely.
 *
 * A grant EXPIRES and the server never extends one on a read, so this renews
 * before the deadline while it is mounted: a card left open in a transcript for
 * an afternoon would otherwise hold a URL that 404s, in the frame and in the
 * tab the corner action opens.
 */
export function SandboxedDocument({
  target,
  title,
  className = "h-96 w-full",
  showOpenAction = false,
  generation = 0,
  scope = "directory",
  contentPolicy = "active",
  sizeBytes,
  fallback,
}: {
  target: DocumentTarget;
  title?: string;
  className?: string;
  /** Adds the corner control that opens the same document in a browser tab. */
  showOpenAction?: boolean;
  /** Bump to re-mint and reload the frame — the viewer's reload-from-disk. */
  generation?: number;
  /** Runnable HTML needs siblings; inert PDF/browser documents use one file. */
  scope?: "directory" | "file";
  /** Passive PDF relies on the browser plugin and omits both sandbox layers. */
  contentPolicy?: "active" | "passive-pdf";
  /** Shown in the PDF panel where the engine cannot frame the document. */
  sizeBytes?: number | undefined;
  /** Inline embeds degrade to their canonical viewer link when minting fails. */
  fallback?: ReactNode;
}) {
  // The KEY carries the generation (a bump drops the old URL and re-mints)
  // while the fetcher closes over the typed source, so no key parsing is needed.
  const { anchor: _anchor, ...targetIdentity } = target;
  const targetKey = documentTargetHref(targetIdentity);
  const { state, reload } = useFetchState<FileGrantUrl>(
    `${targetKey}:${scope}@${generation}`,
    useCallback(
      (_key: string, signal: AbortSignal) =>
        mintFileGrantUrl(target, signal, scope, "inline"),
      [scope, target],
    ),
  );
  const grant = dataOf(state);
  const error = errorOf(state);
  const activeSandbox = contentPolicy === "active" || scope !== "file";
  const [loaded, setLoaded] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const expiresAt = grant?.expiresAt;
  const stale = useCallback(
    () => expiresAt !== undefined && expiresAt - Date.now() <= RENEW_MARGIN_MS,
    [expiresAt],
  );

  useEffect(() => {
    if (expiresAt === undefined) return;
    const due = expiresAt - Date.now() - RENEW_MARGIN_MS;
    // A grant already inside its margin renews on the next tick rather than
    // never: a negative timeout would fire immediately and loop, so floor it.
    const timer = setTimeout(reload, Math.max(due, 1_000));
    // A TIMER IS NOT ENOUGH. A phone that sleeps for two hours resumes with
    // this timeout un-run and a grant that died while the page was frozen, so
    // the frame and the corner action would both point at a 404. Re-check on
    // the events that mean "this page is being looked at again".
    const recheck = () => {
      if (stale()) reload();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [expiresAt, reload, stale]);

  // A new URL is a new document load; the skeleton belongs over it again.
  useEffect(() => setLoaded(false), [grant?.url]);
  useEffect(() => setOpenError(null), [targetKey, generation]);

  if (error) {
    if (fallback) return <>{fallback}</>;
    return (
      <div className="p-3">
        <ErrorNote message={error} onRetry={reload} />
      </div>
    );
  }
  if (!grant) return <Skeleton className={className} />;
  const nativeOpen = opensServedFileInNativeBrowser(grant.url);
  const name = title ?? target.path.split("/").filter(Boolean).pop();

  // One way out to a real browser, shared by the corner action and the PDF
  // panel below: the same live grant, opened the same way.
  const openProps = {
    href: grant.url,
    target: "_blank",
    rel: "noreferrer noopener",
    title: nativeOpen
      ? "Open this document in your browser"
      : "Open this document in a new tab",
    onClick: (event: { preventDefault: () => void }) => {
      if (nativeOpen) {
        event.preventDefault();
        setOpenError(null);
        const shouldRenew = stale();
        void (async () => {
          try {
            // A resume-triggered frame refresh may still be in flight while the
            // rendered grant has expired. Native opening has no popup-activation
            // deadline, so never hand Rust that stale URL.
            const toOpen = shouldRenew
              ? await mintFileGrantUrl(target, undefined, scope, "inline")
              : grant;
            await openNativeServedFile(toOpen.url);
          } catch {
            setOpenError(
              "Could not open this document in your browser. Update the Pandeck app and try again.",
            );
          } finally {
            // Adopt a managed fresh frame/error after the one-off mint.
            if (shouldRenew) reload();
          }
        })();
        return;
      }
      // The URL under the cursor may have just died (see above), so the tab
      // gets a freshly minted one. The ORDER matters twice over:
      //
      //  - the blank tab is opened SYNCHRONOUSLY, while the click's user
      //    activation is still live. Opening it after the mint resolves is
      //    what a popup blocker refuses;
      //  - its handle is what tells us the tab exists. `window.open` with
      //    `noopener` returns null even when it SUCCEEDED, so a same-tab
      //    fallback keyed on the return value would navigate the app away from
      //    under the reader on the happy path. Severing `opener` by hand buys
      //    the same isolation and still answers.
      if (!stale()) return;
      event.preventDefault();
      const tab = window.open("", "_blank");
      if (tab) {
        try {
          tab.opener = null;
        } catch {
          // Read-only in some browsers; the document is sandboxed to an opaque
          // origin either way.
        }
      }
      void mintFileGrantUrl(target, undefined, scope, "inline")
        .then((fresh) => {
          if (tab) tab.location.replace(fresh.url);
          // Blocked: the reader asked for this document, so open it in THIS
          // tab rather than silently doing nothing. `_self` is a navigation,
          // not a popup, so nothing blocks it.
          else window.open(fresh.url, "_self");
        })
        .catch(() => tab?.close())
        // Either way the frame's own URL is stale now; this renews it, and a
        // failure lands in the managed error state rather than in an unhandled
        // rejection.
        .finally(reload);
    },
  } as const;

  // iOS/iPadOS WebKit draws page one of a framed PDF and lets no one scroll it,
  // so there the document is not shown in place at all: the panel says what the
  // file is and opens it where it CAN be read.
  if (contentPolicy === "passive-pdf" && !embeddedPdfScrolls())
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <EmptyBox
          className="w-full max-w-md bg-panel/60"
          action={
            <a
              {...openProps}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground transition-colors hover:opacity-90"
            >
              <ExternalLink size={13} /> Open PDF
            </a>
          }
        >
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-accent text-primary">
            <FileText size={22} />
          </div>
          <h1 className="text-prose font-semibold text-fg">
            {name ?? "Document"}
          </h1>
          {sizeBytes === undefined ? null : (
            <p className="mt-1 text-caption text-faint">
              {formatFileSize(sizeBytes)}
            </p>
          )}
          <p className="mt-2 text-body text-muted-foreground">
            This PDF opens in your browser: iPhone and iPad can't scroll one
            inside the app.
          </p>
          {openError ? (
            <ErrorNote message={openError} className="mt-3" />
          ) : null}
        </EmptyBox>
      </div>
    );

  return (
    // The wrapper takes the height so the frame's own can resolve against it: a
    // viewer asks for `h-full`, and a percentage height inside an auto-height
    // parent is auto — which for an iframe means the browser's 150px default,
    // not the panel. An inline embed's box has no height of its own, so `h-full`
    // stays auto there and its bounded `h-96` frame is unaffected.
    <span className="relative block h-full">
      {loaded ? null : <Skeleton className={`absolute inset-0 ${className}`} />}
      <iframe
        key={grant.url}
        src={grant.url}
        title={name ?? "Document"}
        // Active HTML keeps an opaque origin. Passive, file-scoped PDF omits
        // iframe sandboxing because Chromium/WebKit may otherwise block their
        // built-in PDF renderer; the grant still reaches exactly one file.
        {...(activeSandbox
          ? {
              sandbox:
                "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
            }
          : {})}
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        className={`block border-0 bg-white ${className}`}
      />
      {showOpenAction ? (
        <a
          {...openProps}
          aria-label={openProps.title}
          className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-lg border border-line bg-surface/90 text-muted-foreground transition-colors hover:text-fg"
        >
          <ExternalLink size={14} />
        </a>
      ) : null}
      {openError ? <ErrorNote message={openError} className="mt-2" /> : null}
    </span>
  );
}
