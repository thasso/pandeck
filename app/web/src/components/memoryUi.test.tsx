/**
 * Tasks 101/102: memory Settings section + Session inspector "Loaded memory".
 * SSR snapshot rendering (matches the web test convention).
 *   pnpm --filter @assistant/web test src/components/memoryUi.test.tsx
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AppSettings,
  MemoryCard,
  MemoryLoadBatch,
} from "@assistant/shared";
import { ready, refreshing, loading } from "../lib/loadState.ts";
import type { MemoryListView, UseMemory } from "../hooks/useMemory.ts";
import { LoadedMemorySection } from "./LoadedMemorySection.tsx";
import { MemorySettingsSection } from "./MemorySettingsSection.tsx";

/** A query that answered, which is what lets a list claim a count or zero. */
const listed = (over: Partial<MemoryListView> = {}) =>
  ready<MemoryListView>({ cards: [], total: 0, hasMore: false, ...over });

const memoryStub = (over: Partial<UseMemory> = {}): UseMemory => ({
  list: listed(),
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

const profile: AppSettings["profile"] = {
  displayName: "",
  timeZone: "Europe/Berlin",
  effectiveTimeZone: "Europe/Berlin",
};

const memorySettings: AppSettings["memory"] = {
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

describe("MemorySettingsSection", () => {
  it("shows independent controls and safety-ceiling copy without review terminology", () => {
    const html = renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memoryStub()}
        onUpdate={() => {}}
      />,
    );
    expect(html).toContain("Adaptive");
    expect(html).toContain("Every turn — experimental");
    expect(html).toContain("global safety ceilings");
    expect(html).toContain("Set calls/hour to 0");
    expect(html).toContain("do not auto-capture in v1");
    // Never a review/approval/pending inbox.
    expect(html).not.toMatch(/approve|pending review|accept.*reject/i);
  });

  const card: MemoryCard = {
    id: "mem_1",
    revision: 3,
    text: "Prefers dark mode",
    kind: "preference",
    scope: { persona: "personal-assistant", projectId: "acme" },
    state: "active",
    pinned: false,
    strength: 1,
    temporal: { mode: "persistent" },
    observedAtMs: 0,
    createdAt: 0,
    updatedAt: 0,
    provenance: { sourceKind: "processor", sessionId: "sess-abc12345" },
  };

  it("exposes project/persona/kind/active-now filters alongside search and state", () => {
    const html = renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memoryStub({ list: listed({ cards: [card], total: 1 }) })}
        onUpdate={() => {}}
      />,
    );
    expect(html).toContain("Project id");
    expect(html).toContain("Any persona");
    expect(html).toContain("Active now");
    for (const k of ["preference", "fact", "constraint", "working"])
      expect(html).toContain(k);
  });

  it("shows real pagination controls bounded by total/hasMore", () => {
    const html = renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memoryStub({
          list: listed({ cards: [card], total: 45, hasMore: true }),
        })}
        onUpdate={() => {}}
      />,
    );
    expect(html).toContain("1–1 of 45");
    expect(html).toContain("Prev");
    expect(html).toContain("Next");
  });

  it("shows provenance on each row and a lineage/history action", () => {
    const html = renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memoryStub({ list: listed({ cards: [card], total: 1 }) })}
        onUpdate={() => {}}
      />,
    );
    expect(html).toContain("auto-captured");
    expect(html).toContain("Lineage / provenance");
  });

  it("labels window cards active/expired/upcoming using both from/until bounds, not just validUntilMs (exchange 21)", () => {
    const now = Date.now();
    const upcoming: MemoryCard = {
      ...card,
      id: "mem_upcoming",
      temporal: {
        mode: "window",
        validFromMs: now + 10_000_000,
        validUntilMs: now + 20_000_000,
      },
    };
    const expired: MemoryCard = {
      ...card,
      id: "mem_expired",
      temporal: { mode: "window", validUntilMs: now - 10_000 },
    };
    const active: MemoryCard = {
      ...card,
      id: "mem_active",
      temporal: { mode: "window", validUntilMs: now + 10_000_000 },
    };

    const html = renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memoryStub({
          list: listed({ cards: [upcoming, expired, active], total: 3 }),
        })}
        onUpdate={() => {}}
      />,
    );
    expect(html).toContain("upcoming from");
    expect(html).toContain("expired");
    expect(html).toContain("active until");
  });

  /**
   * The five states of the manager's list (`app/web/docs/loading-states.md`,
   * Task-361 Phase 3d). The one that matters is R1: "No memories match." is an
   * answer, and drawing it over a query still in flight tells the user their
   * memory is gone.
   */
  const renderManager = (memory: UseMemory) =>
    renderToStaticMarkup(
      <MemorySettingsSection
        models={[]}
        settings={{ memory: memorySettings, profile } as AppSettings}
        memory={memory}
        onUpdate={() => {}}
      />,
    );

  it("draws placeholder rows, not an empty state, while the query is in flight", () => {
    const html = renderManager(memoryStub({ list: loading() }));
    expect(html).toContain('aria-label="Loading memories"');
    expect(html).toContain("animate-pulse");
    expect(html).not.toContain("No memories match.");
  });

  it("claims zero only once the query answered", () => {
    const html = renderManager(memoryStub({ list: listed() }));
    expect(html).toContain("No memories match.");
    expect(html).not.toContain('aria-label="Loading memories"');
  });

  it("keeps the rows and marks a refresh of the same query (R2)", () => {
    const html = renderManager(
      memoryStub({
        list: refreshing<MemoryListView>({
          cards: [card],
          total: 1,
          hasMore: false,
        }),
      }),
    );
    expect(html).toContain("Prefers dark mode");
    expect(html).toContain("Refreshing memories");
    expect(html).not.toContain('aria-label="Loading memories"');
  });
});

describe("LoadedMemorySection", () => {
  const injected: MemoryLoadBatch = {
    id: 1,
    sessionId: "s1",
    userTurnId: "t1",
    fingerprint: "fp",
    deliveryState: "injected",
    renderedChars: 40,
    injectedChars: 40,
    cumulativeInjectedChars: 40,
    createdAt: 1,
    items: [
      {
        memoryId: "m1",
        revision: 2,
        rank: 1,
        reasonCode: "baseline-preference",
        reason: "stable preference",
        renderedChars: 40,
        text: "Prefers concise answers",
        kind: "preference",
        scope: { persona: "personal-assistant" },
      },
    ],
  };

  it("renders the effective card text from the audit with the Injected badge", () => {
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub({ loadsBySession: { s1: [injected] } })}
      />,
    );
    expect(html).toContain("Injected");
    expect(html).toContain("Prefers concise answers");
    expect(html).toContain("stable preference");
  });

  it("collapses to a cards-of-budget counter, keeping the card list one click away", () => {
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        maxCards={20}
        memory={memoryStub({ loadsBySession: { s1: [injected] } })}
      />,
    );
    expect(html).toContain("1 of 20");
    // Collapsed by default: the audit itself is not rendered until asked for.
    expect(html).not.toContain("Prefers concise answers");
  });

  it("explains a reused turn instead of showing it empty", () => {
    const reused: MemoryLoadBatch = {
      ...injected,
      id: 2,
      deliveryState: "reused",
      injectedChars: 0,
    };
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub({ loadsBySession: { s1: [reused] } })}
      />,
    );
    expect(html).toContain("Reused");
    expect(html).toContain("the same snapshot is already in the model");
    // Still lists the effective set.
    expect(html).toContain("Prefers concise answers");
  });

  it("distinguishes not-yet-loaded (no fetch response yet) from loaded-but-empty", () => {
    const notYetLoaded = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub()}
      />,
    );
    expect(notYetLoaded).toContain("Not yet loaded");

    const emptyOnPurpose = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub({ loadsBySession: { s1: [] } })}
      />,
    );
    expect(emptyOnPurpose).toContain("No memory has been loaded");
  });

  it("shows a disabled state distinct from not-yet-loaded when memory loading is off", () => {
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub()}
        loadingEnabled={false}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).not.toContain("Not yet loaded");
  });

  it("navigates between recent load batches and shows per-row Details/actions", () => {
    const older: MemoryLoadBatch = {
      ...injected,
      id: 0,
      userTurnId: "t0",
      items: [{ ...injected.items[0]!, text: "Older effective text" }],
    };
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="s1"
        hasAcceptedUserTurn
        defaultOpen
        memory={memoryStub({ loadsBySession: { s1: [injected, older] } })}
      />,
    );
    expect(html).toContain("Turn 1 of 2");
    expect(html).toContain("Older");
    expect(html).toContain("Newer");
    expect(html).toContain("Details");
  });

  it("shows a draft state for a staged/optimistic session id (e.g. pending-pi-session) rather than the not-yet-loaded state", () => {
    // A draft can have a DEFINED but fake sessionId (an optimistic placeholder or
    // client-generated id) — hasAcceptedUserTurn is the authoritative signal, not
    // merely whether sessionId is set.
    const html = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="pending-pi-session"
        hasAcceptedUserTurn={false}
        defaultOpen
        memory={memoryStub()}
      />,
    );
    expect(html).toContain("Draft");
    expect(html).toContain("staged");
    expect(html).not.toContain("Not yet loaded");
  });

  it("renders the actual staged scope in the draft state (exchange 21), not just the generic draft copy", () => {
    const withProject = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="pending-pi-session"
        hasAcceptedUserTurn={false}
        defaultOpen
        stagedScope={{ persona: "personal-assistant", projectId: "acme" }}
        memory={memoryStub()}
      />,
    );
    expect(withProject).toContain("persona: personal-assistant");
    expect(withProject).toContain("project: acme");
  });

  it("resolves a staged Task's ACTUAL project scope (exchange 23), not just its title", () => {
    // Task resolved with a known project.
    const withResolvedProject = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="pending-pi-session"
        hasAcceptedUserTurn={false}
        defaultOpen
        stagedScope={{
          persona: "assistant",
          projectId: "acme",
          pendingTaskTitle: "Ship the release",
        }}
        memory={memoryStub()}
      />,
    );
    expect(withResolvedProject).toContain("project: acme");
    expect(withResolvedProject).toContain("Ship the release");

    // Task resolved but explicitly has no project — must say "global", not claim an unresolved scope.
    const withGlobalTask = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="pending-pi-session"
        hasAcceptedUserTurn={false}
        defaultOpen
        stagedScope={{
          pendingTaskTitle: "Unprojected task",
          projectIsGlobal: true,
        }}
        memory={memoryStub()}
      />,
    );
    expect(withGlobalTask).toContain("global");
    expect(withGlobalTask).toContain("Unprojected task");

    // Task genuinely could not be resolved (not in the known list) — only THIS case says "resolves once sent".
    const withUnresolvedTask = renderToStaticMarkup(
      <LoadedMemorySection
        sessionId="pending-pi-session"
        hasAcceptedUserTurn={false}
        defaultOpen
        stagedScope={{
          pendingTaskTitle: "Unknown task",
          projectUnresolved: true,
        }}
        memory={memoryStub()}
      />,
    );
    expect(withUnresolvedTask).toContain("resolves once sent");
    expect(withUnresolvedTask).toContain("Unknown task");
  });
});
