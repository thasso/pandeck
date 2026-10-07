import { useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Moon,
  PanelLeft,
  PanelRight,
  Sun,
} from "lucide-react";
import type { Prefs } from "../hooks/usePrefs.ts";
import {
  canGoBack,
  canGoForward,
  historyNavVersion,
  subscribeHistoryNav,
} from "../lib/historyNav.ts";
import type { AppReloadState } from "../lib/appStatus.ts";
import { usesOverlayTitlebar } from "../lib/nativeShell.ts";
import { AppHeaderBar } from "./AppHeaderBar.tsx";
import { AppStatus } from "./AppStatus.tsx";
import { UnreadDot } from "./UnreadDot.tsx";

/**
 * @component Topbar
 * @purpose WIDE-LAYOUT application Header Bar: the home of the two pane toggles.
 * @useWhen Composing the desktop shell. Small screens render NO app header at all.
 * @avoidWhen Adding page-, route-, session-, or workflow-specific actions; place those in the local page header, session header, composer, drawer, or docked panel instead. Navigation — sections AND the app-level actions — lives in the left sidebar's primary navigation bar.
 * @intent What is left of the app header after everything found a better home: the
 * app-level actions (Personal Assistant, New Session, Usage) became configurable
 * slots in the sidebar's navigation bar, and the phone has no header at all — its
 * navigation is the browser screen plus the object dock's row. This bar survives on
 * wide layouts only because the sidebar and inspector toggles need somewhere to
 * live, and a closed sidebar cannot host the control that reopens it. The toggles
 * are a matching `PanelLeft`/`PanelRight` pair — one control shape for "show/hide a
 * panel" — rather than bracketing the bar, which read as two unrelated controls,
 * and they use the same muted icon style as everything else: accent coloring made
 * them look permanently activated. Topbar stays route-unaware.
 * The history arrows lead the bar for the same reason the toggles trail it: they
 * are WINDOW chrome, not page content, and every window that has ever had them
 * puts them in the top-left. They are the one navigation control in the app that
 * retraces steps rather than addressing a place, which is why they are here and
 * not in the sidebar's nav bar — and why they are the one thing allowed to call
 * `history.back()`, unlike the surfaces' own Back (see `src/CLAUDE.md`).
 * In the native shell this bar IS the window's title bar rather than a row under
 * one (macOS draws its window controls over the page), so it drags the window and
 * keeps its leading edge clear of them. That is why the shell costs no extra
 * chrome height: there was already a bar here, and it absorbed the job.
 * @related AppHeaderBar, Sidebar, shell/PrimaryNav, lib/nativeShell.
 */
interface Props {
  prefs: Prefs;
  updatePrefs: (patch: Partial<Prefs>) => void;
  /** Whether the left sidebar is currently open. Drives the indicator dot. */
  sidebarOpen: boolean;
  /** Whether the right inspector panel is open. Drives the indicator dot. */
  inspectorOpen: boolean;
  /** Toggle the left sidebar panel. */
  onToggleSidebar: () => void;
  /** Toggle the right inspector panel. */
  onToggleInspector: () => void;
  /** App status slot state; this bar is its wide-layout placement. */
  connected: boolean;
  reloading: AppReloadState | null | undefined;
  hydrationSource: "empty" | "cache" | "live";
}

/** Shared shape of every header action: a muted icon button. */
const ACTION_CLASS =
  "relative flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-panel hover:text-fg";

export function Topbar({
  prefs,
  updatePrefs,
  sidebarOpen,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  connected,
  reloading,
  hydrationSource,
}: Props) {
  const dragRegion = usesOverlayTitlebar();
  // Read through an external store rather than state: the position changes from
  // outside React (a `popstate`, a push from the router) and several bars can be
  // mounted at once.
  useSyncExternalStore(subscribeHistoryNav, historyNavVersion);
  const backAvailable = canGoBack();
  const forwardAvailable = canGoForward();
  return (
    <AppHeaderBar dragRegion={dragRegion}>
      {/*
        RESERVES the native window controls' room in the shell
        (`--app-drag-inset-left`, 0px in a browser), as padding rather than a note
        in a doc, so anything at this edge starts clear of the traffic lights
        rather than underneath them.

        It is marked as a drag region too even though it is zero-width in a
        browser and never receives the pointer: the native handler tests the
        element the click HIT, not its ancestors, so any child that comes to
        cover the bar has to carry the attribute itself or that stretch of the
        bar stops dragging. The buttons deliberately do NOT carry it — a marked
        control drags the window instead of being pressed.
      */}
      <div
        data-tauri-drag-region={dragRegion || undefined}
        className="flex shrink-0 items-center gap-0.5 pl-[var(--app-drag-inset-left,0px)]"
      >
        <button
          type="button"
          onClick={() => window.history.back()}
          disabled={!backAvailable}
          title="Back"
          aria-label="Back"
          className={`${ACTION_CLASS} disabled:pointer-events-none disabled:opacity-30`}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          onClick={() => window.history.forward()}
          disabled={!forwardAvailable}
          title="Forward"
          aria-label="Forward"
          className={`${ACTION_CLASS} disabled:pointer-events-none disabled:opacity-30`}
        >
          <ArrowRight size={15} />
        </button>
      </div>

      {/* The app status slot (`docs/messaging.md`): app-wide lifecycle state
          only, centred in the space the bar already had spare. It replaces the
          plain spacer rather than adding height, which is the reason this
          placement exists — a banner would push every pane down on each blip. */}
      <div
        data-tauri-drag-region={dragRegion || undefined}
        className="flex min-w-0 flex-1 items-center justify-center"
      >
        <AppStatus
          connected={connected}
          reloading={reloading}
          hydrationSource={hydrationSource}
          placement="bar"
        />
      </div>

      <button
        type="button"
        onClick={() =>
          updatePrefs({ theme: prefs.theme === "dark" ? "light" : "dark" })
        }
        title="Toggle theme"
        className={ACTION_CLASS}
      >
        {prefs.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>

      {/* One pair, so they sit tighter than a lone action would. */}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          className={ACTION_CLASS}
        >
          <PanelLeft size={15} />
          {sidebarOpen && <UnreadDot title="Sidebar open" />}
        </button>
        <button
          type="button"
          onClick={onToggleInspector}
          title="Toggle inspector"
          aria-label="Toggle inspector"
          className={ACTION_CLASS}
        >
          <PanelRight size={15} />
          {inspectorOpen && <UnreadDot title="Inspector open" />}
        </button>
      </div>
    </AppHeaderBar>
  );
}
