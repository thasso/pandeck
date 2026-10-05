import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import {
  documentTargetHref,
  type DocumentTarget,
} from "@assistant/shared/documentTargets";
import {
  canGoBack,
  canGoForward,
  currentDocumentScroll,
  closeDocument,
  flushDocumentScroll,
  goBack,
  goForward,
  historyNavVersion,
  saveDocumentScroll,
  subscribeHistoryNav,
} from "../lib/historyNav.ts";
import { useMobileLayout } from "./shell/useMobileLayout.ts";
import type { DocumentZoomMode } from "../lib/documentZoom.ts";
import {
  DocumentZoomActions,
  useDocumentZoomBehavior,
  useDocumentZoomRegistration,
  type DocumentZoomRegistration,
} from "./DocumentZoom.tsx";
import { PageHeader, type PageHeaderIconTone } from "./PageHeader.tsx";
import { GhostIconButton } from "./ui/GhostIconButton.tsx";
import { worktreePath } from "../hooks/useSessionRouting.ts";

export interface DocumentSourceAction {
  id: string;
  label: string;
  icon: ReactNode;
  onRun: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

export interface DocumentNavigationRegistration {
  /** History capability revision represented by canBack/canForward. */
  historyVersion: number;
  id: string;
  target: DocumentTarget;
  title: string;
  canBack: boolean;
  canForward: boolean;
  back: () => void | Promise<void>;
  forward: () => void;
  close: () => void;
  sourceActions: readonly DocumentSourceAction[];
  zoom?: DocumentZoomRegistration;
}

let activeRegistration: DocumentNavigationRegistration | null = null;
let registrationVersion = 0;
let publicationOrder = 0;
const registrations = new Map<
  symbol,
  {
    registration: DocumentNavigationRegistration;
    priority: number;
    order: number;
  }
>();
const registrationListeners = new Set<() => void>();

function publishDocumentNavigation(
  owner: symbol,
  registration: DocumentNavigationRegistration | null,
  priority: number,
): void {
  if (registration) {
    registrations.set(owner, {
      registration,
      priority,
      order: ++publicationOrder,
    });
  } else {
    registrations.delete(owner);
  }
  activeRegistration =
    [...registrations.values()]
      .sort(
        (left, right) =>
          left.priority - right.priority || left.order - right.order,
      )
      .at(-1)?.registration ?? null;
  registrationVersion += 1;
  for (const listener of registrationListeners) listener();
}

function subscribeDocumentNavigation(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export function useDocumentNavigationRegistration(): DocumentNavigationRegistration | null {
  useSyncExternalStore(
    subscribeDocumentNavigation,
    () => registrationVersion,
    () => registrationVersion,
  );
  return activeRegistration;
}

/** Desktop controls for a source page that supplies its own identity header. */
export function DocumentNavigationActions({
  className = "",
}: {
  className?: string;
}) {
  const navigation = useDocumentNavigationRegistration();
  if (!navigation) return null;
  // Back and Forward are the leading pair, everything else follows, and Close
  // is last — the same order the phone's dock row uses.
  return (
    <div className={`items-center gap-1 ${className}`}>
      <GhostIconButton
        label="Back"
        onClick={() => void navigation.back()}
        disabled={!navigation.canBack}
        icon={<ArrowLeft size={16} />}
      />
      <GhostIconButton
        label="Forward"
        onClick={navigation.forward}
        disabled={!navigation.canForward}
        icon={<ArrowRight size={16} />}
      />
      {navigation.zoom ? <DocumentZoomActions zoom={navigation.zoom} /> : null}
      <GhostIconButton
        label="Close document"
        onClick={navigation.close}
        icon={<X size={16} />}
      />
    </div>
  );
}

export function documentCloseFallback(target: DocumentTarget): string {
  switch (target.kind) {
    case "sessionArtifact":
      return `/sessions/${encodeURIComponent(target.sessionId)}`;
    case "worktreeFile":
      return worktreePath(
        target.worktreeId,
        target.view === "diff" ? "changes" : "files",
      );
    case "hostFile":
      return "/sessions";
  }
}

const NO_SOURCE_ACTIONS: readonly DocumentSourceAction[] = [];

/**
 * Give one document's outer viewer its history entry's scroll position back,
 * and keep saving it. The scroller is found by `id` (its own
 * `data-document-scroll`, or the one inside that `data-document-scroll-root`),
 * so a page that registers through `DocumentNavigationMarker` and lays out its
 * own panes — the worktree file and diff views — calls this instead of growing
 * a second registration. `null` while no document is open. A line anchor wins:
 * the reader asked for a line, not for where they last were.
 */
function findDocumentScroller(id: string): HTMLElement | null {
  const escaped = CSS.escape(id);
  return document.querySelector<HTMLElement>(
    `[data-document-scroll="${escaped}"], [data-document-scroll-root="${escaped}"] [data-document-scroll]`,
  );
}

export function useDocumentScrollRestoration(
  id: string | null,
  hasAnchor: boolean,
): void {
  useLayoutEffect(() => {
    if (hasAnchor || id === null) return;
    const saved = currentDocumentScroll();
    if (!saved) return;

    let frame: number | undefined;
    let timeout: number | undefined;
    let observer: MutationObserver | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let pending: MutationObserver | undefined;
    let pendingTimeout: number | undefined;
    let listening: HTMLElement | undefined;
    const cleanupWaiters = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout !== undefined) window.clearTimeout(timeout);
      observer?.disconnect();
      resizeObserver?.disconnect();
      listening?.removeEventListener("load", onLoad, true);
    };
    const onLoad = () => {
      if (listening) tryRestore(listening);
    };
    const enoughExtent = (scroller: HTMLElement) =>
      saved.top <= Math.max(0, scroller.scrollHeight - scroller.clientHeight) &&
      saved.left <= Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const restore = (scroller: HTMLElement) => {
      scroller.scrollTop = saved.top;
      scroller.scrollLeft = saved.left;
      cleanupWaiters();
    };
    const tryRestore = (scroller: HTMLElement) => {
      if (enoughExtent(scroller)) restore(scroller);
    };
    const watch = (scroller: HTMLElement) => {
      listening = scroller;
      frame = window.requestAnimationFrame(() => tryRestore(scroller));
      observer = new MutationObserver(() => tryRestore(scroller));
      observer.observe(scroller, { childList: true, subtree: true });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => tryRestore(scroller));
        resizeObserver.observe(scroller.firstElementChild ?? scroller);
      }
      scroller.addEventListener("load", onLoad, true);
      // Do not watch an opaque/failed renderer indefinitely. The final
      // assignment restores as far as the outer viewer can currently scroll.
      timeout = window.setTimeout(() => restore(scroller), 2_000);
      tryRestore(scroller);
    };

    const scroller = findDocumentScroller(id);
    if (scroller) watch(scroller);
    else {
      // A page whose pane arrives with its data — the worktree diff — has no
      // scroller yet on this commit. Bounded, like every other wait here.
      pending = new MutationObserver(() => {
        const late = findDocumentScroller(id);
        if (!late) return;
        pending?.disconnect();
        watch(late);
      });
      pending.observe(document.body, { childList: true, subtree: true });
      pendingTimeout = window.setTimeout(() => pending?.disconnect(), 2_000);
    }
    return () => {
      pending?.disconnect();
      if (pendingTimeout !== undefined) window.clearTimeout(pendingTimeout);
      cleanupWaiters();
    };
  }, [hasAnchor, id]);
  useEffect(() => {
    if (id === null) return;
    // Listening on the document rather than on the element keeps this correct
    // for a pane that mounts later, and the identity check is what keeps a
    // nested code scroller out of the entry the outer viewer owns.
    let cached: HTMLElement | null = null;
    const scroller = () => {
      if (!cached?.isConnected) cached = findDocumentScroller(id);
      return cached;
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target !== scroller()) return;
      saveDocumentScroll(target.scrollTop, target.scrollLeft);
    };
    const onScrollEnd = (event: Event) => {
      if (event.target !== scroller()) return;
      flushDocumentScroll();
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("scrollend", onScrollEnd, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("scrollend", onScrollEnd, true);
      flushDocumentScroll();
    };
  }, [id]);
}

function usePublishDocumentNavigation(
  target: DocumentTarget,
  title: string,
  sourceActions: readonly DocumentSourceAction[] = NO_SOURCE_ACTIONS,
  priority = 1,
  zoomMode: DocumentZoomMode | null = "text",
): DocumentNavigationRegistration {
  const owner = useRef(Symbol("document-navigation")).current;
  const navVersion = useSyncExternalStore(
    subscribeHistoryNav,
    historyNavVersion,
    historyNavVersion,
  );
  const id = documentTargetHref(target);
  // Anchors are positions inside one document, so Back/Forward and scroll keep
  // the full href while zoom follows the anchor-free document identity.
  const zoomId = id.split("#", 1)[0] ?? id;
  const zoom = useDocumentZoomRegistration(zoomId, zoomMode);
  const fallback = documentCloseFallback(target);
  const close = useCallback(() => closeDocument(fallback), [fallback]);
  const registration = useMemo<DocumentNavigationRegistration>(
    () => ({
      // Keeps Back/Forward capability snapshots tied to the store revision.
      historyVersion: navVersion,
      id,
      target,
      title,
      canBack: canGoBack(),
      canForward: canGoForward(),
      back: goBack,
      forward: goForward,
      close,
      sourceActions,
      ...(zoom ? { zoom } : {}),
    }),
    [close, id, navVersion, sourceActions, target, title, zoom],
  );
  useLayoutEffect(() => {
    publishDocumentNavigation(owner, registration, priority);
    return () => publishDocumentNavigation(owner, null, priority);
  }, [owner, priority, registration]);
  return registration;
}

/** Registers an embedded source renderer that keeps its own identity header. */
export function DocumentNavigationMarker({
  target,
  title,
  sourceActions,
  zoomMode = "text",
  manageZoom = false,
}: {
  target: DocumentTarget;
  title: string;
  sourceActions?: readonly DocumentSourceAction[];
  zoomMode?: DocumentZoomMode | null;
  /** Loaded source markers own scroller/zoom; route-only markers publish navigation only. */
  manageZoom?: boolean;
}) {
  const registration = usePublishDocumentNavigation(
    target,
    title,
    sourceActions,
    0,
    manageZoom ? zoomMode : null,
  );
  useDocumentZoomBehavior(
    registration.id,
    manageZoom ? registration.zoom : undefined,
  );
  return null;
}

/**
 * Navigation and identity shared by host files, artifacts, KB files and
 * worktree documents. Source renderers remain separate and supply the body.
 */
export function DocumentNavigationShell({
  target,
  title,
  subtitle,
  icon,
  iconTone,
  actions,
  sourceActions = NO_SOURCE_ACTIONS,
  embedded = false,
  zoomMode = "text",
  children,
}: {
  target: DocumentTarget;
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  iconTone?: PageHeaderIconTone;
  /** Wide-header rendering of source actions. */
  actions?: ReactNode;
  /** Typed source actions also rendered by the mobile object dock. */
  sourceActions?: readonly DocumentSourceAction[];
  /** Register navigation without adding an identity row owned by the source page. */
  embedded?: boolean;
  /** Text reflows; visual content scales within the document scroller. */
  zoomMode?: DocumentZoomMode | null;
  children: ReactNode;
}) {
  const mobile = useMobileLayout();
  const registration = usePublishDocumentNavigation(
    target,
    title,
    sourceActions,
    1,
    zoomMode,
  );
  const close = registration.close;
  useDocumentScrollRestoration(registration.id, Boolean(target.anchor));
  useDocumentZoomBehavior(registration.id, registration.zoom);

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      data-document-scroll-root={registration.id}
    >
      {!embedded ? (
        <PageHeader
          density={mobile ? "compact" : "default"}
          icon={icon}
          {...(iconTone ? { iconTone } : {})}
          title={title}
          subtitle={subtitle}
          objectOverflow={false}
          actions={
            mobile ? undefined : (
              // Back and Forward lead as one pair.
              <div className="flex items-center gap-1">
                <GhostIconButton
                  label="Back"
                  onClick={() => void goBack()}
                  disabled={!registration.canBack}
                  icon={<ArrowLeft size={16} />}
                />
                <GhostIconButton
                  label="Forward"
                  onClick={goForward}
                  disabled={!registration.canForward}
                  icon={<ArrowRight size={16} />}
                />
                {actions}
                {sourceActions.map((action) => (
                  <GhostIconButton
                    key={action.id}
                    label={
                      action.disabled && action.disabledReason
                        ? action.disabledReason
                        : action.label
                    }
                    onClick={action.onRun}
                    {...(action.disabled !== undefined
                      ? { disabled: action.disabled }
                      : {})}
                    icon={action.icon}
                  />
                ))}
                {registration.zoom ? (
                  <DocumentZoomActions zoom={registration.zoom} />
                ) : null}
              </div>
            )
          }
          // Close is the last control in the header, after the document's own
          // comment controls, as it is the last control in the phone's dock row.
          close={
            mobile ? undefined : (
              <GhostIconButton
                label="Close document"
                onClick={close}
                icon={<X size={16} />}
              />
            )
          }
        />
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
