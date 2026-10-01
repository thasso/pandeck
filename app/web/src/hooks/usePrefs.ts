import { applyPatch } from "@assistant/shared";
import { useCallback, useEffect, useState } from "react";
import type {
  TaskStatus,
  ThinkingLevel,
  WorkflowRunLimits,
} from "@assistant/shared";
import {
  ALL_PROJECT_FILTER,
  normalizeBacklogView,
  type BacklogProjectFilter,
  type BacklogView,
  type BacklogViewMode,
} from "../lib/backlogTreeModel.ts";
import {
  DEFAULT_NAV_SLOTS,
  normalizeNavSlots,
  type NavSlot,
} from "./useSidebarSection.ts";

type Theme = "dark" | "light";

/** Supported browser-local text-scale percentages. Typography only — never a
 *  UI-density or geometry setting. */
export type TextScale = 100 | 110 | 120 | 130;

const TEXT_SCALES: readonly TextScale[] = [100, 110, 120, 130];

/** Coerce any stored/unknown value to a supported scale, defaulting to 100. */
export function normalizeTextScale(value: unknown): TextScale {
  const n = typeof value === "number" ? value : Number(value);
  return (TEXT_SCALES as readonly number[]).includes(n)
    ? (n as TextScale)
    : 100;
}

/** One remembered runtime: the model, the account it came from, and thinking. */
interface StoredWorkflowRuntime {
  modelKey: string;
  credentialProfileId?: string;
  thinkingLevel: ThinkingLevel;
  family?: string;
  notes?: string;
}

/** The workflow start sheet's remembered coordinator and per-role sets. */
export interface StoredWorkflowRuntimes {
  coordinator?: StoredWorkflowRuntime;
  roles: Record<
    "implementer" | "reviewer" | "fixer" | "verdict",
    StoredWorkflowRuntime[]
  >;
}

export function normalizeWorkflowRoleRuntimes(
  stored: unknown,
): StoredWorkflowRuntimes | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const value = stored as Partial<StoredWorkflowRuntimes>;
  if (!value.roles || typeof value.roles !== "object") return undefined;
  return {
    ...(value.coordinator ? { coordinator: value.coordinator } : {}),
    roles: {
      implementer: Array.isArray(value.roles.implementer)
        ? value.roles.implementer
        : [],
      reviewer: Array.isArray(value.roles.reviewer) ? value.roles.reviewer : [],
      fixer: Array.isArray(value.roles.fixer) ? value.roles.fixer : [],
      verdict: Array.isArray(value.roles.verdict) ? value.roles.verdict : [],
    },
  };
}

export interface Prefs {
  theme: Theme;
  /** Browser-local text size (percent). Scales the six typography roles only. */
  textScale: TextScale;
  showThinking: boolean;
  showTools: boolean;
  /**
   * Whether thinking blocks / tool calls render EXPANDED. Flipping one re-syncs
   * every mounted block (expand-all / collapse-all) and every block that arrives
   * afterwards, so it is one control rather than a one-shot action plus a default.
   */
  expandThinking: boolean;
  expandTools: boolean;
  /**
   * Wrap long lines in native tool bodies (read/write/edit/bash) instead of
   * scrolling them horizontally. Off by default: code and shell output are
   * column-aligned, and wrapping destroys that alignment.
   */
  wrapToolLines: boolean;
  sidebarWidth: number;
  /**
   * Order of the sidebar's primary-navigation bar, front to back — sections AND
   * the app-level actions that share it. The bar shows as many as fit at its
   * current width; the tail folds into More. Kept browser-local because the ideal
   * order differs between a phone overlay and a resizable desktop panel.
   */
  navSlots: NavSlot[];
  taskDrawerWidth: number;
  backlogMasterWidth: number;
  animateLeftSidebar: boolean;
  animateRightDrawer: boolean;
  /**
   * Animate a list REARRANGING itself — today the Sessions inbox: the card you
   * settle slides out to the left before the rows below it close the gap, and a
   * card whose state moved it travels to its new place instead of jumping. Like
   * every animation preference it only ever adds motion: the outcome, and the
   * order it happens in, are identical with it off.
   */
  animateListChanges: boolean;
  /** Backlog status filter: the statuses shown. Empty or all-three = no filter. */
  backlogStatusFilter: TaskStatus[];
  /** Which Backlog view is on screen: the hand-arranged tree, or when-grouped Focus. */
  backlogView: BacklogView;
  /** Backlog layout WITHIN the tree view: flat task hierarchy vs. grouped-by-project. */
  backlogViewMode: BacklogViewMode;
  /** Backlog project filter: which project(s) the list is narrowed to. */
  backlogProjectFilter: BacklogProjectFilter;
  /** Calendar: the last-selected view, restored when the calendar is reopened. */
  calendarView: "month" | "week" | "day";
  /** Calendar: include Saturday/Sunday in month + week views. */
  calendarShowWeekends: boolean;
  /** Calendar: overlay my logged Tempo time alongside events. */
  calendarShowTempo: boolean;
  /** Calendar: pixels per hour in the week/day time grid (vertical zoom). */
  calendarHourPx: number;
  /** Calendar right panel: height (px) of the day-details region above the chat. */
  calendarDetailHeight: number;
  /** Worktree detail views: width of the local navigator rail. */
  worktreeChangesRailWidth: number;
  /** Worktree detail views: whether the local navigator rail is collapsed. */
  worktreeChangesRailCollapsed: boolean;
  /** Worktree detail views: flat list vs folder tree for file/change navigators. */
  worktreeNavigatorViewMode: "list" | "tree";
  /**
   * Worktree Review tab mode: one file at a time vs the whole changeset in one
   * scroll. Unset = device default (changeset on mobile, by-file on desktop).
   */
  worktreeReviewMode?: "by-file" | "changeset";
  /** Diff rendering: unified vs side-by-side. */
  diffStyle: "unified" | "split";
  /** Diff rendering: intra-line word-level highlighting. */
  diffWordLevel: boolean;
  /** Diff rendering: treat lines differing only in leading/trailing whitespace as unchanged. */
  diffIgnoreWhitespace: boolean;
  /** Diff rendering: wrap long lines instead of horizontal scrolling. */
  diffWrap: boolean;
  /** Diff rendering: expand unchanged context by default. */
  diffExpandContext: boolean;
  /**
   * Last model the user explicitly selected, remembered as the default for new
   * chats. Stored in `modelKey` form (`provider:id`); undefined until first pick.
   */
  lastModelKey?: string;
  /** Credential profile selected for the next new session. */
  credentialProfileId?: string;
  /**
   * Last thinking level the user explicitly selected, remembered as the default
   * for new chats. Undefined until the user first picks one.
   */
  lastThinkingLevel?: ThinkingLevel;
  /**
   * Runtimes of the last STARTED workflow run: the coordinator runtime and the
   * four role-scoped candidate sets in sheet order, so the common path is a one-tap start. `modelKey` is the `provider:id` form; the
   * account travels with it because the same model on two accounts is two
   * different choices. A cancelled start sheet never writes here.
   */
  workflowRoleRuntimes?: StoredWorkflowRuntimes;
  /**
   * Run limits of the last STARTED workflow run. Restored (and clamped back
   * into today's bounds) for the next run; prompt overrides deliberately are
   * NOT remembered — they are Task-specific.
   */
  workflowRunLimits?: WorkflowRunLimits;
}

const KEY = "assistant.prefs";

const defaults: Prefs = {
  theme: "dark",
  textScale: 100,
  showThinking: false,
  showTools: false,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
  sidebarWidth: 256,
  navSlots: [...DEFAULT_NAV_SLOTS],
  taskDrawerWidth: 320,
  backlogMasterWidth: 360,
  animateLeftSidebar: true,
  animateRightDrawer: true,
  animateListChanges: true,
  backlogStatusFilter: ["todo", "doing", "done"],
  backlogView: "backlog",
  backlogViewMode: "normal",
  backlogProjectFilter: ALL_PROJECT_FILTER,
  calendarView: "month",
  calendarShowWeekends: false,
  calendarShowTempo: true,
  calendarHourPx: 48,
  calendarDetailHeight: 300,
  worktreeChangesRailWidth: 300,
  worktreeChangesRailCollapsed: false,
  worktreeNavigatorViewMode: "tree",
  diffStyle: "unified",
  diffWordLevel: true,
  diffIgnoreWhitespace: true,
  diffWrap: false,
  diffExpandContext: false,
};

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const workflowRoleRuntimes = normalizeWorkflowRoleRuntimes(
      parsed.workflowRoleRuntimes,
    );
    return {
      ...applyPatch(defaults, parsed),
      textScale: normalizeTextScale(parsed.textScale),
      navSlots: normalizeNavSlots(parsed.navSlots),
      backlogView: normalizeBacklogView(parsed.backlogView),
      ...(workflowRoleRuntimes !== undefined ? { workflowRoleRuntimes } : {}),
    };
  } catch {
    return defaults;
  }
}

/** Reflect the text-scale preference onto the root element as the
 *  `data-text-scale` attribute the CSS `--text-scale` variable keys off. Kept
 *  in sync with the pre-paint bootstrap in index.html. */
function applyTextScale(scale: TextScale) {
  document.documentElement.setAttribute("data-text-scale", String(scale));
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load);

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(prefs));
    const root = document.documentElement;
    root.classList.toggle("dark", prefs.theme === "dark");
    applyTextScale(prefs.textScale);
  }, [prefs]);

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => ({ ...p, ...patch }));
  }, []);

  return { prefs, update };
}
