// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AppSettings, MemoryCard } from "@assistant/shared";
import { ready } from "../lib/loadState.ts";
import type { MemoryListView, UseMemory } from "../hooks/useMemory.ts";
import { MemorySettingsSection } from "./MemorySettingsSection.tsx";

/**
 * The memory manager's per-row lineage slot
 * (`app/web/docs/loading-states.md`, Task-361 Phase 3d).
 *
 * The slot is keyed by memory id ON PURPOSE (`hooks/useMemory.ts`): two rows —
 * here and in the Session inspector — can be open at once, so each waits on its
 * own answer and each draws its own placeholder. What it must never do is state
 * prose ("Loading lineage…") where the lineage itself will be.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card: MemoryCard = {
  id: "mem_1",
  revision: 1,
  text: "Prefers dark mode",
  kind: "preference",
  scope: { persona: "personal-assistant" },
  state: "active",
  pinned: false,
  strength: 1,
  temporal: { mode: "persistent" },
  observedAtMs: 0,
  createdAt: 0,
  updatedAt: 0,
  provenance: { sourceKind: "processor" },
};

const profile: AppSettings["profile"] = {
  displayName: "",
  timeZone: "Europe/Berlin",
  effectiveTimeZone: "Europe/Berlin",
};

const settings: AppSettings["memory"] = {
  loadingEnabled: true,
  learningMode: "adaptive",
  maintenanceEnabled: true,
  maxCards: 8,
  maxRenderedChars: 1200,
  processor: {
    provider: "github-copilot",
    modelId: "gpt-4.1",
    thinkingLevel: "off",
  },
  maxCallsPerHour: 12,
  maxCostPerDayUsd: 1,
};

const memory = (over: Partial<UseMemory> = {}): UseMemory => ({
  list: ready<MemoryListView>({ cards: [card], total: 1, hasMore: false }),
  filter: { states: ["active"] },
  lineageById: {},
  loadsBySession: {},
  processorStatus: null,
  setFilter: () => {},
  refresh: () => {},
  mutate: async () => ({ ok: true }) as never,
  openLineage: () => {},
  clearLineage: () => {},
  fetchLoads: () => {},
  fetchStatus: () => {},
  ...over,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("draws a placeholder in the slot of the row whose lineage was opened", async () => {
  await act(async () => {
    root!.render(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: settings, profile } as AppSettings}
        memory={memory()}
        onUpdate={() => {}}
      />,
    );
  });

  const toggle = [...container!.querySelectorAll("button")].find(
    (button) => button.getAttribute("title") === "Lineage / provenance",
  );
  expect(toggle).toBeTruthy();
  await act(async () => {
    toggle!.click();
  });

  const slot = container!.querySelector('[aria-label="Loading lineage"]');
  expect(slot).toBeTruthy();
  expect(slot!.querySelectorAll(".motion-safe\\:animate-pulse").length).toBe(2);
  expect(container!.textContent).not.toContain("Loading lineage…");
});
