import type {
  ContextInfo,
  DisplayBlock,
  DisplayMessage,
  SessionState,
} from "@assistant/shared";
import { isTransientMessageId } from "./sessionPreview.ts";
import { sessionIdFromPathname } from "./sessionRoutes.ts";

/**
 * The chat surface's BOOT cache: the last transcript this browser had on screen
 * for a session, in `localStorage`, so a reload or a deep link onto that
 * session's URL paints it in the first frame instead of a spinner.
 *
 * It is one of the two client transcript caches and the SMALLER one — the other
 * is `lib/sessionTimelineCache.ts` (IndexedDB), which holds the append-only
 * `ClientTimelineEntry` prefix the server's tail-only delta is computed
 * against. Their roles are documented in `app/web/docs/loading-states.md`; the
 * short version is that this one exists because it is SYNCHRONOUS (an
 * IndexedDB read cannot answer before the first paint) and because it carries
 * the projected `DisplayMessage`s plus the session shell the stage needs to
 * draw, which the timeline prefix alone does not.
 *
 * Since Task-435 a preview is only ever painted on the route the app BOOTED on:
 * `previewForSessionRoute` is the one place that rule lives.
 */

const SESSION_PREVIEW_KEY = "assistant.sessionPreview.v1";
const SESSION_PREVIEW_LIMIT = 8;

export interface SessionPreview {
  sessionId: string;
  session: SessionState;
  messages: DisplayMessage[];
  contextInfo: ContextInfo | null;
  savedAt: number;
}

interface SessionPreviewStore {
  version: 1;
  previews: Record<string, SessionPreview>;
}

/**
 * The boot route's identity, SPENT by the first navigation away from it.
 *
 * One-way on purpose: returning to the session the app booted on is an in-app
 * arrival like any other by then, and the app has been live in between, so the
 * stored copy is exactly the thing we know is behind. Without the latch that
 * return would not merely paint stale rows — while the runtime still holds the
 * OTHER session, `appendLiveMessagesAfterPreview` finds no anchor and hands
 * back the live list wholesale, i.e. the other conversation under this URL.
 *
 * Repeating the same identity (a reconnect, a router re-parse, a same-path tap)
 * keeps it, which is what preserves the reload and reconnect paints.
 */
export function spendBootRouteIdentity(
  bootRouteIdentity: string | null,
  routeIdentity: string,
): string | null {
  if (bootRouteIdentity === null) return null;
  return bootRouteIdentity === routeIdentity ? bootRouteIdentity : null;
}

/**
 * The cached transcript a session route may paint before its snapshot lands —
 * and, with `spendBootRouteIdentity`, the ONE place the boot-only rule lives.
 *
 * Cached first paint is earned where nothing else can be on screen yet: a
 * reload or deep link that lands on a session URL, and the reconnect of that
 * same view (the route identity does not change, so the preview survives it).
 * An in-app switch has a live app around it, so it clears the stage and waits
 * for the snapshot rather than repainting a possibly hours-old transcript under
 * the new id (R3, `app/web/docs/loading-states.md`). A spent boot identity
 * (`null`) is that same answer for every route, including the boot one.
 */
export function previewForSessionRoute(
  held: SessionPreview | null,
  route: { identity: string; sessionId: string | null },
  bootRouteIdentity: string | null,
): SessionPreview | null {
  if (!held || route.sessionId === null || bootRouteIdentity === null)
    return null;
  if (route.identity !== bootRouteIdentity) return null;
  return held.sessionId === route.sessionId ? held : null;
}

function truncateText(value: string, max = 20000): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sanitizeBlock(block: DisplayBlock): DisplayBlock {
  if (block.kind === "text" || block.kind === "thinking")
    return { ...block, text: truncateText(block.text) };
  if (block.kind === "tool")
    return { ...block, output: truncateText(block.output, 12000) };
  if (block.kind === "attachment") {
    // The payload must be REMOVED, not set to undefined: spreading the original
    // attachment would otherwise carry the full base64 body into the preview.
    const { data: _strippedData, ...attachment } = block.attachment;
    return { ...block, attachment };
  }
  return block;
}

function sanitizeMessages(messages: DisplayMessage[]): DisplayMessage[] {
  // Persist only durable rows. The streaming pseudo-row ("live") and optimistic
  // prompts recur with the same id in later turns, so a cached copy would anchor
  // the preview merge at the CURRENT turn's live row and hide everything between
  // the stale preview and it (see isTransientMessageId). The streaming flag is a
  // moment-in-time state too and must not resurrect as a stuck spinner.
  return messages
    .filter((message) => !isTransientMessageId(message.id))
    .slice(-60)
    .map(({ streaming: _streaming, ...message }) => ({
      ...message,
      blocks: message.blocks.map(sanitizeBlock),
    }));
}

function parseSessionPreviewStore(raw: string | null): SessionPreviewStore {
  if (!raw) return { version: 1, previews: {} };
  const parsed = JSON.parse(raw) as
    Partial<SessionPreviewStore> | SessionPreview | null;
  if (!parsed || typeof parsed !== "object")
    return { version: 1, previews: {} };
  if (
    "previews" in parsed &&
    parsed.previews &&
    typeof parsed.previews === "object"
  ) {
    return {
      version: 1,
      previews: parsed.previews as Record<string, SessionPreview>,
    };
  }
  return { version: 1, previews: {} };
}

function loadSessionPreviewStore(): SessionPreviewStore {
  try {
    return parseSessionPreviewStore(localStorage.getItem(SESSION_PREVIEW_KEY));
  } catch {
    return { version: 1, previews: {} };
  }
}

/** The preview for the session URL this app run started on, if there is one. */
export function loadBootSessionPreview(
  pathname: string,
): SessionPreview | null {
  if (typeof window === "undefined") return null;
  const id = sessionIdFromPathname(pathname);
  if (!id) return null;
  return loadSessionPreviewStore().previews[id] ?? null;
}

export function saveSessionPreview(preview: SessionPreview): void {
  try {
    const store = loadSessionPreviewStore();
    const sanitized: SessionPreview = {
      ...preview,
      messages: sanitizeMessages(preview.messages),
    };
    const previews = { ...store.previews, [preview.sessionId]: sanitized };
    const trimmed = Object.fromEntries(
      Object.entries(previews)
        .sort((a, b) => b[1].savedAt - a[1].savedAt)
        .slice(0, SESSION_PREVIEW_LIMIT),
    );
    localStorage.setItem(
      SESSION_PREVIEW_KEY,
      JSON.stringify({
        version: 1,
        previews: trimmed,
      } satisfies SessionPreviewStore),
    );
  } catch {
    // Best-effort cache only; quota/private-mode failures should not affect chat.
  }
}
