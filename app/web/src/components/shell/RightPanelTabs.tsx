import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { BookOpen, Bot, GitBranch, Plus, ScanSearch, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useSessionStorageState } from "../../hooks/useSessionStorageState.ts";
import { IconButton } from "../common/IconButton.tsx";
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PersonalAssistantPanel } from "./PersonalAssistantPanel.tsx";

/**
 * @component RightPanelTabs
 * @purpose Desktop-only tab host for the shell's right panel: opens, activates,
 * and closes contextual panel surfaces while retaining an empty panel home.
 * @useWhen Adding a desktop right-panel surface: register it in PANEL_IDS,
 * PANEL_DEFINITIONS and `panelBodies`.
 * @avoidWhen Rendering the mobile object dock; it deliberately stays the direct
 * Inspector surface with no tab chrome.
 * @intent Tabs are user-owned `sessionStorage` layout state. Closing every tab
 * leaves a centered chooser of available panels rather than closing the entire
 * sidebar.
 */
export type PanelId =
  "inspector" | "personal-assistant" | "knowledge" | "worktree";

interface PanelDefinition {
  id: PanelId;
  label: string;
  icon: ReactNode;
  /**
   * Mount this panel's body while the right panel is CLOSED. Only for a
   * surface the shell needs for something other than looking at: the Inspector
   * publishes the page header's overflow actions (`shell/Inspector.tsx`), which
   * is why its host stays mounted when the panel is shut. Everything else is a
   * reader — it fetches, subscribes and (for diffs) starts a worker on mount —
   * and waits to be looked at.
   */
  mountsWhenHidden?: boolean;
}

interface RightPanelTabState {
  openTabs: PanelId[];
  activeTab: PanelId | null;
}

const TAB_STORAGE_KEY = "assistant.right-panel-tabs.v1";

const PANEL_IDS: PanelId[] = [
  "inspector",
  "personal-assistant",
  "knowledge",
  "worktree",
];

function panelDefinition(id: PanelId): PanelDefinition {
  return PANEL_DEFINITIONS.find((panel) => panel.id === id)!;
}

function isPanelId(value: unknown): value is PanelId {
  return PANEL_IDS.includes(value as PanelId);
}

function decodeTabState(raw: string): RightPanelTabState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<RightPanelTabState>;
    const openTabs = Array.isArray(candidate.openTabs)
      ? candidate.openTabs.filter(isPanelId)
      : [];
    const activeTab = isPanelId(candidate.activeTab)
      ? candidate.activeTab
      : null;
    return {
      openTabs,
      activeTab: openTabs.includes(activeTab!) ? activeTab : null,
    };
  } catch {
    return null;
  }
}

const PANEL_DEFINITIONS: PanelDefinition[] = [
  {
    id: "inspector",
    label: "Inspector",
    icon: <ScanSearch />,
    mountsWhenHidden: true,
  },
  {
    id: "personal-assistant",
    label: "Personal Assistant",
    icon: <Bot />,
  },
  { id: "knowledge", label: "Knowledge", icon: <BookOpen /> },
  { id: "worktree", label: "Worktree", icon: <GitBranch /> },
];

/** One open panel's tab: drag it to reorder, or close it from its own X. */
function SortablePanelTab({
  id,
  onClose,
}: {
  id: PanelId;
  onClose: () => void;
}) {
  const panel = panelDefinition(id);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`flex shrink-0 items-center ${isDragging ? "z-10 opacity-50" : ""}`}
    >
      {/* The drag handle's description, but not its `role="button"`: this is
          a tab of the strip, and arrow keys move between tabs. */}
      <TabsTrigger
        value={id}
        aria-roledescription={attributes["aria-roledescription"]}
        aria-describedby={attributes["aria-describedby"]}
        className={isDragging ? "cursor-grabbing" : undefined}
        {...listeners}
      >
        {panel.icon}
        <span className="max-w-28 truncate">{panel.label}</span>
      </TabsTrigger>
      <IconButton
        label={`Close ${panel.label}`}
        size="icon-xs"
        onClick={onClose}
      >
        <X />
      </IconButton>
    </div>
  );
}

export function RightPanelTabs({
  inspector,
  knowledge,
  worktree,
  visible = true,
  openRequest,
  onActivePanelChange,
}: {
  inspector: ReactNode;
  /** Absent while the app offers no Knowledge Base: the tab is not offered. */
  knowledge?: ReactNode;
  worktree: ReactNode;
  /**
   * The right panel is open, so its active tab is actually on screen. The host
   * stays mounted while the panel is shut (the Inspector publishes from here),
   * and a tab nobody has looked at yet must not start working in that state.
   */
  visible?: boolean;
  /**
   * Show this panel now, opening its tab if it is closed — an action elsewhere
   * in the app asking for a surface here (a transcript card's "Open in side
   * panel"). A fresh `nonce` is what makes the SAME panel a new request.
   */
  openRequest?: { panel: PanelId; nonce: number } | undefined;
  /**
   * Report which panel is the active, visible one — null on the panel home.
   * A tab that is merely OPEN stays mounted behind another, so what a panel
   * draws (an inspector's data, an entry's failure note) is only on screen
   * while it is the active one.
   */
  onActivePanelChange?: ((panel: PanelId | null) => void) | undefined;
}) {
  const [tabState, setTabState] = useSessionStorageState<RightPanelTabState>(
    TAB_STORAGE_KEY,
    { openTabs: ["inspector"], activeTab: "inspector" },
    decodeTabState,
  );
  // A panel the app does not offer right now (the Knowledge Base turned off)
  // keeps its place in the stored layout, so it comes back where it was, but
  // is neither shown nor offered.
  const offered = (id: PanelId) =>
    id !== "knowledge" || knowledge !== undefined;
  const openTabs = tabState.openTabs.filter(offered);
  const activeTab =
    tabState.activeTab && offered(tabState.activeTab)
      ? tabState.activeTab
      : null;
  useEffect(() => {
    onActivePanelChange?.(activeTab);
  }, [activeTab, onActivePanelChange]);
  /**
   * Panels that have been on screen at least once in this page load: the active
   * tab of an OPEN panel. A tab restored from `sessionStorage` behind another —
   * or with the whole right panel closed, which still keeps this host mounted —
   * has never been LOOKED at, and a panel that draws an object fetches it,
   * subscribes to it and (for the worktree's diffs) spins up a worker the
   * moment it mounts. So a body waits for that first sighting; from then on it
   * stays mounted behind whatever is in front of it (and while the panel is
   * shut), which is what makes a tab switch free.
   */
  const [revealed, setRevealed] = useState<PanelId[]>(() =>
    visible && activeTab ? [activeTab] : [],
  );
  useEffect(() => {
    if (!visible || !activeTab) return;
    setRevealed((current) =>
      current.includes(activeTab) ? current : [...current, activeTab],
    );
  }, [visible, activeTab]);
  const selectTab = (activeTab: PanelId | null) => {
    setTabState((current) => ({ ...current, activeTab }));
  };
  const openPanel = (id: PanelId) => {
    setTabState((current) => ({
      openTabs: current.openTabs.includes(id)
        ? current.openTabs
        : [...current.openTabs, id],
      activeTab: id,
    }));
  };

  // An outside request opens and activates its panel. It is keyed on the nonce
  // alone: asking for the panel that is already active must still bring it
  // forward when the user has since selected another tab.
  const requestedPanel = openRequest?.panel;
  const requestedNonce = openRequest?.nonce;
  useEffect(() => {
    if (!requestedPanel || requestedNonce === undefined) return;
    setTabState((current) => ({
      openTabs: current.openTabs.includes(requestedPanel)
        ? current.openTabs
        : [...current.openTabs, requestedPanel],
      activeTab: requestedPanel,
    }));
  }, [requestedPanel, requestedNonce, setTabState]);

  const closePanel = (id: PanelId) => {
    setTabState((current) => {
      const openTabs = current.openTabs.filter((tab) => tab !== id);
      return {
        openTabs,
        activeTab:
          current.activeTab === id
            ? (openTabs.at(-1) ?? null)
            : current.activeTab,
      };
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const reorderTabs = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setTabState((current) => {
      const from = current.openTabs.indexOf(active.id as PanelId);
      const to = current.openTabs.indexOf(over.id as PanelId);
      if (from < 0 || to < 0) return current;
      return { ...current, openTabs: arrayMove(current.openTabs, from, to) };
    });
  };
  const showTabs = openTabs.length > 0;
  // The Personal Assistant is the one surface this host owns outright: it holds
  // its own connection and has nothing to take from the app around it.
  const panelBodies: Record<PanelId, ReactNode> = {
    inspector,
    "personal-assistant": <PersonalAssistantPanel />,
    knowledge,
    worktree,
  };
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-card">
      {showTabs ? (
        <div className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border px-2">
          <Tabs
            value={activeTab}
            onValueChange={(value: PanelId) => selectTab(value)}
            className="min-w-0 flex-1"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={reorderTabs}
            >
              <SortableContext
                items={openTabs}
                strategy={horizontalListSortingStrategy}
              >
                <TabsList
                  variant="line"
                  className="right-panel-tab-list w-full justify-start overflow-x-auto"
                >
                  {openTabs.map((id) => (
                    <SortablePanelTab
                      key={id}
                      id={id}
                      onClose={() => closePanel(id)}
                    />
                  ))}
                </TabsList>
              </SortableContext>
            </DndContext>
          </Tabs>
          <IconButton
            label="Open a right panel"
            size="icon"
            onClick={() => selectTab(null)}
          >
            <Plus />
          </IconButton>
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {/* Once revealed, an open tab stays mounted while another tab or the
            panel home is visible. Inspector data therefore survives a tab
            switch; closing its tab is the explicit choice that releases it and
            its cached view. */}
        {PANEL_IDS.filter(
          (id) =>
            openTabs.includes(id) &&
            (revealed.includes(id) || panelDefinition(id).mountsWhenHidden),
        ).map((id) => (
          <div
            key={id}
            className={activeTab === id ? "h-full" : "hidden"}
            aria-hidden={activeTab !== id || undefined}
            inert={activeTab !== id || undefined}
          >
            {panelBodies[id]}
          </div>
        ))}
        {activeTab === null ? (
          <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2 px-5">
            <p className="text-sm text-muted-foreground">Open a panel</p>
            <div className="flex w-full max-w-56 flex-col gap-1">
              {PANEL_DEFINITIONS.filter((panel) => offered(panel.id)).map(
                (panel) => (
                  <Item
                    key={panel.id}
                    size="sm"
                    render={<button type="button" />}
                    onClick={() => openPanel(panel.id)}
                    className="text-left hover:bg-muted"
                  >
                    <ItemMedia variant="icon">{panel.icon}</ItemMedia>
                    <ItemContent>
                      <ItemTitle>{panel.label}</ItemTitle>
                    </ItemContent>
                  </Item>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
