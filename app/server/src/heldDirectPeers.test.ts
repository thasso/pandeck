/**
 * Directly spawned children waiting for a slot ([Task-966](pa://task/966)):
 * the start pass, its triggers, the start-time re-check against the CURRENT
 * approval, and silent cancellation. The store, the admission lock and the
 * notice store are real; account discovery, runtime state and the drain are
 * observed through spies.
 */
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { AccountModelOption, PeerSpawnRuntime } from "@assistant/shared";
import type { RuntimePromptDriver } from "./session/runtimePrompt.ts";
import { installDeliveryTestScheduler } from "./test/deliveryScheduler.ts";
import { setDeliveryWake } from "./deliveryWake.ts";

const { fakeDrivers, fakeHub } = vi.hoisted(() => {
  const fakeDrivers = new Map<string, unknown>();
  const fakeHub = {
    getLiveById: (id: string) => fakeDrivers.get(id),
    acquireById: async (id: string) => fakeDrivers.get(id),
    broadcastSessions: () => {},
    broadcastPeerPromptCardUpdate: () => {},
    broadcastPeerPromptQueue: () => {},
  };
  return { fakeDrivers, fakeHub };
});

vi.mock("./hub.ts", () => ({ hub: fakeHub }));

const profiles = [
  {
    id: "codex-acct",
    name: "Work Codex",
    provider: "openai-codex",
    enabled: true,
    enterprise: false,
  },
];

vi.mock("./credentialProfiles.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listCredentialProfiles: () => profiles,
    credentialProfileById: (id: string) =>
      profiles.find((profile) => profile.id === id),
  };
});

const { sessionStore } = await import("./db/sessionStore.ts");
const { peerPromptStore } = await import("./db/peerPromptStore.ts");
const { delegationFailureNoticeStore } =
  await import("./db/delegationFailureNoticeStore.ts");
const { closeDb, getDb } = await import("./db/index.ts");
const { updateSettings } = await import("./settings.ts");
const runtimes = await import("./peerSpawnRuntimes.ts");
const {
  admitDirectPeerTurns,
  recordDirectPeerChild,
  resetDirectPeerChildrenForTests,
  setSessionPeerTurnCap,
} = runtimes;
const inspection = await import("./tools/sessions/sessionInspection.ts");
const peerPrompt = await import("./peerPrompt.ts");
const {
  cancelQueuedPeerPrompts,
  peerPromptQueueField,
  sendQueuedPeerPromptNow,
  setHubForTests,
  setPeerPromptAutoDeliverForTests,
  withdrawQueuedPeerPrompt,
} = peerPrompt;
const agentSpawn = await import("./agents/agentSpawn.ts");
const held = await import("./heldDirectPeers.ts");
const {
  cancelHeldForArchivedSessions,
  cancelHeldForDeletedSession,
  installHeldDirectPeerStarts,
  nudgeHeldStartsForChild,
  startHeldDirectPeers,
  startHeldDirectPeersOnBoot,
} = held;
const { FakeRuntimeDriver } = await import("./test/fakeRuntimeDriver.ts");

setHubForTests(fakeHub as never);
beforeAll(() => installHeldDirectPeerStarts());

const MODEL: AccountModelOption = {
  provider: "openai-codex",
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  reasoning: true,
  supportedThinkingLevels: ["off", "low", "medium", "high"],
  contextWindow: 400_000,
  credentialProfileId: "codex-acct",
  accountName: "Work Codex",
} as AccountModelOption;

const runtimeRow = (
  patch: Partial<PeerSpawnRuntime> = {},
): PeerSpawnRuntime => ({
  id: "pr_terra",
  name: "Terra implementer",
  relativeCost: "high",
  credentialProfileId: "codex-acct",
  provider: "openai-codex",
  modelId: "gpt-5.6-terra",
  thinkingLevel: "medium",
  enabled: true,
  ...patch,
});

let n = 0;
let states: Map<string, string>;
let drains: ReturnType<typeof spyDrains>;
/** Runs inside account discovery: the await before Settings are read. */
let duringDiscovery: (() => void) | undefined;

function session(title: string, agentType = "developer"): string {
  const id = `held-${n++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: agentType as never,
    title,
    scope: "user",
  });
  return id;
}

/** A coordinator with its own cap. */
function spawner(cap = 2): string {
  const id = session("Coordinator", "assistant");
  setSessionPeerTurnCap(id, cap);
  return id;
}

function register(
  coord: string,
  child: string,
  source:
    | { kind: "profile"; profileId: string }
    | { kind: "agent"; agentName: string } = {
    kind: "profile",
    profileId: "pr_terra",
  },
): void {
  recordDirectPeerChild({
    childSessionId: child,
    spawnerSessionId: coord,
    costClass: "counted",
    source,
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    thinkingLevel: "medium",
    credentialProfileId: "codex-acct",
    createdAt: Date.now(),
  });
}

/** Counted children of `coord` that are running right now. */
function running(coord: string, count: number): string[] {
  return Array.from({ length: count }, () => {
    const child = session("Busy child");
    sessionStore.linkSpawned(coord, child);
    register(coord, child);
    states.set(child, "running");
    return child;
  });
}

/** A child created over the cap, its opening prompt held. */
function waiting(
  coord: string,
  title = "Waiting child",
  source?: Parameters<typeof register>[2],
): { child: string; rowId: string } {
  const child = session(title);
  sessionStore.linkSpawned(coord, child);
  register(coord, child, source);
  const row = peerPromptStore.enqueueRouted({
    conversationId: `conv-${child}`,
    chainId: peerPromptStore.createChain(),
    senderSessionId: coord,
    recipientSessionId: child,
    participants: [coord, child],
    maxHops: 10,
    prompt: `start ${title}`,
    responseRequested: true,
    expiresAt: Date.now() + 1_000,
    held: { queueSeq: peerPromptStore.allocateQueueSeq() },
  });
  return { child, rowId: row.id };
}

const spyDrains = () =>
  vi.spyOn(peerPrompt, "drainRecipient").mockResolvedValue(undefined);
const statusOf = (id: string) => peerPromptStore.getById(id)?.status;
const drained = () => drains.mock.calls.map(([id]) => id);
const noticeKeys = (coord: string) =>
  delegationFailureNoticeStore.pendingFor(coord).map((n) => n.incidentKey);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Let scheduled wakes (the cap setter, the settlement hook) finish. */
async function flush(coord: string): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await settle();
    await startHeldDirectPeers(coord);
  }
}

beforeEach(() => {
  setPeerPromptAutoDeliverForTests(false);
  resetDirectPeerChildrenForTests();
  profiles[0]!.enabled = true;
  profiles[0]!.enterprise = false;
  updateSettings({ peerSpawnRuntimes: [runtimeRow()] });
  duringDiscovery = undefined;
  states = new Map();
  vi.spyOn(inspection, "runtimeStateReader").mockResolvedValue(
    (id: string) => (states.get(id) ?? "idle") as never,
  );
  vi.spyOn(inspection, "runtimeStateFor").mockImplementation(
    async (id: string) => (states.get(id) ?? "idle") as never,
  );
  vi.spyOn(runtimes, "accountModelOptions").mockImplementation(async () => {
    duringDiscovery?.();
    return profiles[0]!.enabled
      ? [MODEL]
      : [{ ...MODEL, accountDisabled: true }];
  });
  vi.spyOn(runtimes, "modelsForProfile").mockImplementation(async () => {
    duringDiscovery?.();
    return [MODEL];
  });
  drains = spyDrains();
  vi.spyOn(agentSpawn, "agentDefinitionBlob").mockResolvedValue("blob-1");
});

afterEach(() => {
  setDeliveryWake(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  fakeDrivers.clear();
  updateSettings({ peerSpawnRuntimes: [] });
});

/* ------------------------------ starting -------------------------------- */

test("raising the cap starts waiting children at once, in order; lowering starts and stops nothing", async () => {
  const coord = spawner(2);
  const busy = running(coord, 2);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  const c = waiting(coord, "C");

  // The setter stays synchronous: persisted before anything awaits.
  expect(setSessionPeerTurnCap(coord, 3)).toBeUndefined();
  expect(runtimes.directPeerTurnCapOf(coord)).toBe(3);
  await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("queued"));
  await flush(coord);
  expect(drained()).toEqual([a.child]);
  expect([statusOf(b.rowId), statusOf(c.rowId)]).toEqual(["held", "held"]);

  setSessionPeerTurnCap(coord, 5);
  await vi.waitFor(() => expect(statusOf(c.rowId)).toBe("queued"));
  expect(drained()).toEqual([a.child, b.child, c.child]);

  const d = waiting(coord, "D");
  setSessionPeerTurnCap(coord, 1);
  await flush(coord);
  expect(statusOf(d.rowId)).toBe("held");
  expect(drained()).toHaveLength(3);
  expect(busy.every((child) => states.get(child) === "running")).toBe(true);
  expect(statusOf(a.rowId)).toBe("queued");
});

test("a pass waiting on the lock uses the cap raised meanwhile", async () => {
  const coord = spawner(1);
  running(coord, 1);
  const a = waiting(coord, "A");
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  vi.mocked(inspection.runtimeStateReader).mockImplementation(async () => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
    return (id: string) => (states.get(id) ?? "idle") as never;
  });
  const pass = startHeldDirectPeers(coord);
  await inside;
  sessionStore.setPeerTurnCap(coord, 2);
  unblock();
  await pass;
  expect(statusOf(a.rowId)).toBe("queued");
});

test("a start pass and an overlapping batch never hand out one slot twice", async () => {
  const coord = spawner(4);
  running(coord, 3);
  const rows = [waiting(coord, "A"), waiting(coord, "B"), waiting(coord, "C")];
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  let first = true;
  vi.mocked(inspection.runtimeStateReader).mockImplementation(async () => {
    if (first) {
      first = false;
      await blocked;
    }
    return (id: string) => (states.get(id) ?? "idle") as never;
  });
  const pass = startHeldDirectPeers(coord);
  const batch = admitDirectPeerTurns(coord, ["counted"]);
  unblock();
  const [, claim] = await Promise.all([pass, batch]);
  const promoted = rows.filter((r) => statusOf(r.rowId) === "queued").length;
  const started = claim.rows.filter((row) => "start" in row).length;
  expect(promoted + started).toBe(1);
  expect(promoted).toBe(1);
  claim.release();
  for (const row of claim.rows)
    if ("holdSeq" in row) claim.settleHold(row.holdSeq);
});

test("a slot frees on the child's idle edge only once its row is finished", async () => {
  const coord = spawner(1);
  const busy = session("Busy child");
  sessionStore.linkSpawned(coord, busy);
  register(coord, busy);
  const opener = peerPromptStore.enqueue({
    conversationId: `conv-${busy}`,
    chainId: peerPromptStore.createChain(),
    hop: 1,
    senderSessionId: coord,
    recipientSessionId: busy,
    prompt: "work",
    responseRequested: true,
  });
  peerPromptStore.claimNext(busy, "test", 60_000);
  peerPromptStore.markAdmitted(opener.id);
  peerPromptStore.markAcknowledged(opener.id);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");

  // The run ended but its row is still acknowledged: the slot is taken.
  nudgeHeldStartsForChild(busy);
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("held");

  // Settlement, through the one broadcast every transition passes.
  const done = peerPromptStore.markCompleted(opener.id)!;
  peerPrompt.broadcastPeerPromptChanges([done]);
  await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("queued"));
  expect(statusOf(b.rowId)).toBe("held");
});

test("a user turn ending in a counted child starts the next waiting one", async () => {
  const coord = spawner(1);
  const [busy] = running(coord, 1);
  const a = waiting(coord, "A");
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("held");
  states.set(busy!, "idle");
  nudgeHeldStartsForChild(busy!);
  await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("queued"));
});

test("cancelling a queued row frees its slot for the next waiting child", async () => {
  const coord = spawner(1);
  const busy = session("Queued child");
  sessionStore.linkSpawned(coord, busy);
  register(coord, busy);
  peerPromptStore.enqueue({
    conversationId: `conv-${busy}`,
    chainId: peerPromptStore.createChain(),
    hop: 1,
    senderSessionId: coord,
    recipientSessionId: busy,
    prompt: "work",
    responseRequested: false,
  });
  const a = waiting(coord, "A");
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("held");
  cancelQueuedPeerPrompts({
    recipientSessionId: busy,
    senderSessionId: coord,
    reason: "not needed",
  });
  await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("queued"));
});

test("a pass schedules no timer", async () => {
  const coord = spawner(1);
  waiting(coord, "A");
  waiting(coord, "B");
  vi.useFakeTimers();
  const before = vi.getTimerCount();
  await startHeldDirectPeers(coord);
  expect(vi.getTimerCount()).toBe(before);
});

test("an earlier withdrawal beats the promotion; the pass moves on", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  withdrawQueuedPeerPrompt(
    a.child,
    peerPromptQueueField(a.child).queuedPeerPrompts![0]!.id,
  );
  expect(peerPromptStore.promoteHeld(a.rowId, null)).toBeUndefined();
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("cancelled");
  expect(statusOf(b.rowId)).toBe("queued");
  expect(drained()).toEqual([b.child]);
  expect(noticeKeys(coord)).toEqual([]);
});

test("promotion restarts the reply deadline", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const before = peerPromptStore.getById(a.rowId)!.expiresAt!;
  await flush(coord);
  expect(peerPromptStore.getById(a.rowId)!.expiresAt!).toBeGreaterThan(
    before + 24 * 60 * 60_000,
  );
});

/* ------------------------------- restart -------------------------------- */

test("held rows and the children that count survive a restart", async () => {
  const coord = spawner(1);
  const busy = session("Queued child");
  sessionStore.linkSpawned(coord, busy);
  register(coord, busy);
  const work = peerPromptStore.enqueue({
    conversationId: `conv-${busy}`,
    chainId: peerPromptStore.createChain(),
    hop: 1,
    senderSessionId: coord,
    recipientSessionId: busy,
    prompt: "work",
    responseRequested: false,
  });
  const a = waiting(coord, "A");
  closeDb();
  getDb();
  startHeldDirectPeersOnBoot();
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("held");
  peerPromptStore.claimNext(busy, "test", 60_000);
  peerPromptStore.markAdmitted(work.id);
  const done = peerPromptStore.markCompleted(work.id)!;
  peerPrompt.broadcastPeerPromptChanges([done]);
  await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("queued"));
});

test("a boot whose only peer rows are held starts them", async () => {
  const coord = spawner(2);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  closeDb();
  getDb();
  startHeldDirectPeersOnBoot();
  await vi.waitFor(() => expect(drained()).toEqual([a.child, b.child]));
  expect([statusOf(a.rowId), statusOf(b.rowId)]).toEqual(["queued", "queued"]);
});

/* ------------------------------ re-check -------------------------------- */

const AGENT = { kind: "agent", agentName: "test-reviewer" } as const;

const refusals: Array<{
  category: string;
  agent?: boolean;
  arrange: () => void;
}> = [
  {
    category: "held_runtime_removed",
    arrange: () => updateSettings({ peerSpawnRuntimes: [] }),
  },
  {
    category: "held_runtime_disabled",
    arrange: () =>
      updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] }),
  },
  {
    category: "held_runtime_changed",
    arrange: () =>
      updateSettings({
        peerSpawnRuntimes: [runtimeRow({ thinkingLevel: "high" })],
      }),
  },
  {
    category: "held_runtime_changed",
    arrange: () =>
      updateSettings({
        peerSpawnRuntimes: [runtimeRow({ credentialProfileId: "other-acct" })],
      }),
  },
  {
    category: "held_account_unavailable",
    arrange: () => {
      profiles[0]!.enabled = false;
    },
  },
  {
    category: "held_agent_removed",
    agent: true,
    arrange: () => {
      vi.spyOn(agentSpawn, "resolveAgentRole").mockRejectedValue(
        new agentSpawn.AgentSpawnRefusedError("gone"),
      );
    },
  },
  {
    category: "held_agent_changed",
    agent: true,
    arrange: () => {
      vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue({
        role: { persona: "assistant", blob: "blob-1" } as never,
        listed: [],
      });
    },
  },
  {
    category: "held_agent_changed",
    agent: true,
    arrange: () => {
      vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue({
        role: { persona: "developer", blob: "blob-1" } as never,
        listed: [
          {
            spec: "terra",
            runtime: {
              model: MODEL,
              thinkingLevel: "low",
            },
          } as never,
        ],
      });
    },
  },
];

test.each(refusals)(
  "a waiting child is refused with its reason and a notice: $category",
  async ({ category, agent, arrange }) => {
    const coord = spawner(1);
    const a = waiting(coord, "A", agent ? AGENT : undefined);
    arrange();
    await flush(coord);
    expect(statusOf(a.rowId)).toBe("failed");
    expect(peerPromptStore.getById(a.rowId)!.failureReason).toMatch(
      /^Not started: /,
    );
    expect(noticeKeys(coord)).toContain(`held-start:${a.rowId}`);
    const notice = delegationFailureNoticeStore
      .pendingFor(coord)
      .find((n) => n.incidentKey === `held-start:${a.rowId}`)!;
    expect(notice.category).toBe(category);
  },
);

test("an allowed agent child starts; a body-only edit does not refuse it", async () => {
  vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue({
    role: { persona: "developer", body: "edited", blob: "blob-1" } as never,
    listed: [
      {
        spec: "terra",
        runtime: { model: MODEL, thinkingLevel: "medium" },
      } as never,
    ],
  });
  const coord = spawner(1);
  const a = waiting(coord, "A", AGENT);
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("queued");
});

test("a refused child frees nothing and blocks nothing: the next one starts in the same pass", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  // A runs on a row the user then disabled; B on another, still approved.
  getDb()
    .prepare(
      "UPDATE direct_peer_children SET profile_id = 'pr_old' WHERE child_session_id = ?",
    )
    .run(a.child);
  updateSettings({
    peerSpawnRuntimes: [
      runtimeRow(),
      runtimeRow({ id: "pr_old", name: "Old row", enabled: false }),
    ],
  });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(statusOf(b.rowId)).toBe("queued");
  // A's drain is for whatever queued behind its refused opener.
  expect(drained()).toEqual([a.child, b.child]);
});

test("an approval revoked while discovery is awaited refuses instead of starting", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  duringDiscovery = () =>
    updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
});

test("a refusal whose notice cannot be written leaves the row waiting, then refuses it once", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
  const record = vi
    .spyOn(delegationFailureNoticeStore, "record")
    .mockImplementationOnce(() => {
      throw new Error("SQLITE_FULL");
    });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("held");
  expect(noticeKeys(coord)).toEqual([]);
  expect(drained()).toEqual([]);
  record.mockRestore();
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(noticeKeys(coord)).toEqual([`held-start:${a.rowId}`]);
});

test("a cap lowered while the re-check awaits discovery keeps the child waiting", async () => {
  const coord = spawner(2);
  running(coord, 1);
  const a = waiting(coord, "A");
  duringDiscovery = () => {
    duringDiscovery = undefined;
    sessionStore.setPeerTurnCap(coord, 1);
  };
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("held");
  expect(drained()).toEqual([]);
});

test("a slot the user's Send now takes while the re-check awaits is not handed out again", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  duringDiscovery = () => {
    duringDiscovery = undefined;
    peerPromptStore.claimOne(b.rowId, "send-now");
  };
  await startHeldDirectPeers(coord);
  expect(statusOf(b.rowId)).toBe("dispatching");
  expect(statusOf(a.rowId)).toBe("held");
});

test("an account disabled while discovery is awaited refuses the child", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  // Discovery answered with the account still enabled; it is disabled now.
  vi.mocked(runtimes.accountModelOptions).mockImplementation(async () => {
    profiles[0]!.enabled = false;
    return [MODEL];
  });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(
    delegationFailureNoticeStore.pendingFor(coord).map((n) => n.category),
  ).toEqual(["held_account_unavailable"]);
});

const ALLOWED_ROLE = {
  role: { persona: "developer", blob: "blob-1" } as never,
  listed: [
    {
      spec: "terra",
      runtime: { model: MODEL, thinkingLevel: "medium" },
    } as never,
  ],
};

test("a definition edited after it was checked refuses the child", async () => {
  vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue(ALLOWED_ROLE);
  vi.mocked(agentSpawn.agentDefinitionBlob).mockResolvedValue("blob-2");
  const coord = spawner(1);
  const a = waiting(coord, "A", AGENT);
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(
    delegationFailureNoticeStore.pendingFor(coord).map((n) => n.category),
  ).toEqual(["held_agent_changed"]);
});

test("a definition that can no longer be read at the last moment refuses the child", async () => {
  vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue(ALLOWED_ROLE);
  vi.mocked(agentSpawn.agentDefinitionBlob).mockResolvedValue(undefined);
  const coord = spawner(1);
  const a = waiting(coord, "A", AGENT);
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(
    delegationFailureNoticeStore.pendingFor(coord).map((n) => n.category),
  ).toEqual(["held_agent_removed"]);
});

test("an approval revoked while the slots are counted refuses instead of starting", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  let sweeps = 0;
  vi.mocked(inspection.runtimeStateReader).mockImplementation(async () => {
    if (++sweeps === 2)
      updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
    return () => "idle";
  });
  await startHeldDirectPeers(coord);
  expect(sweeps).toBeGreaterThanOrEqual(2);
  expect(statusOf(a.rowId)).toBe("failed");
});

test("an account disabled while the slots are counted refuses instead of starting", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  let sweeps = 0;
  vi.mocked(inspection.runtimeStateReader).mockImplementation(async () => {
    if (++sweeps === 2) profiles[0]!.enabled = false;
    return () => "idle";
  });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
});

test("a user turn started during the last definition read takes the slot", async () => {
  const coord = spawner(1);
  const [busy] = running(coord, 1);
  states.set(busy!, "idle");
  const a = waiting(coord, "A", AGENT);
  vi.spyOn(agentSpawn, "resolveAgentRole").mockResolvedValue(ALLOWED_ROLE);
  vi.mocked(agentSpawn.agentDefinitionBlob).mockImplementation(async () => {
    states.set(busy!, "running");
    return "blob-1";
  });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("held");
});

test("withdrawing a waiting opener delivers what was queued behind it", async () => {
  const coord = spawner(1);
  running(coord, 1);
  const a = waiting(coord, "A");
  const followUp = peerPromptStore.enqueue({
    conversationId: `conv-${a.child}`,
    chainId: peerPromptStore.createChain(),
    hop: 1,
    senderSessionId: session("Someone else", "assistant"),
    recipientSessionId: a.child,
    prompt: "a later message",
    responseRequested: false,
  });
  fakeDrivers.set(a.child, new FakeRuntimeDriver(a.child));
  drains.mockRestore();
  installDeliveryTestScheduler({
    live: (id) => fakeHub.getLiveById(id) as RuntimePromptDriver | undefined,
    acquire: async (id) =>
      (await fakeHub.acquireById(id)) as RuntimePromptDriver | undefined,
  });
  withdrawQueuedPeerPrompt(
    a.child,
    peerPromptQueueField(a.child).queuedPeerPrompts![0]!.id,
  );
  await vi.waitFor(() => expect(statusOf(followUp.id)).toBe("completed"));
  expect(statusOf(a.rowId)).toBe("cancelled");
});

test("a refused opener lets what was queued behind it be delivered", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const followUp = peerPromptStore.enqueue({
    conversationId: `conv-${a.child}`,
    chainId: peerPromptStore.createChain(),
    hop: 1,
    senderSessionId: session("Someone else", "assistant"),
    recipientSessionId: a.child,
    prompt: "a later message",
    responseRequested: false,
  });
  updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("failed");
  // Only the drain runs, for the queued message: nothing was promoted.
  expect(drained()).toEqual([a.child]);
  expect(statusOf(followUp.id)).toBe("queued");
});

/* ------------------------------ Send now -------------------------------- */

test("a held send is stored waiting at its admitted place, and its card reads queued", async () => {
  const coord = spawner(1);
  const child = session("Child");
  const states: string[] = [];
  const original = fakeHub.broadcastPeerPromptCardUpdate;
  fakeHub.broadcastPeerPromptCardUpdate = ((
    _id: string,
    update: { state: string },
  ) => states.push(update.state)) as never;
  try {
    const queueSeq = peerPromptStore.allocateQueueSeq();
    const { message } = await peerPrompt.sendPeerPrompt({
      senderSessionId: coord,
      targetSessionId: child,
      prompt: "start when there is room",
      responseRequested: true,
      hold: { queueSeq },
    });
    expect(message).toMatchObject({ status: "held", queueSeq });
    await settle();
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((state) => state === "queued")).toBe(true);
  } finally {
    fakeHub.broadcastPeerPromptCardUpdate = original;
  }
});

test("the child's queue shows the held prompt as waiting for a slot", () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  expect(peerPromptQueueField(a.child).queuedPeerPrompts).toEqual([
    expect.objectContaining({ waitingForSlot: true }),
  ]);
});

test("Send now starts a waiting child past the cap and its FIFO, and restarts the reply deadline", async () => {
  const coord = spawner(1);
  running(coord, 1);
  waiting(coord, "A");
  const b = waiting(coord, "B");
  const before = peerPromptStore.getById(b.rowId)!.expiresAt!;
  fakeDrivers.set(b.child, new FakeRuntimeDriver(b.child));
  drains.mockRestore();
  await sendQueuedPeerPromptNow(
    b.child,
    peerPromptQueueField(b.child).queuedPeerPrompts![0]!.id,
  );
  const row = peerPromptStore.getById(b.rowId)!;
  expect(["admitted", "acknowledged", "awaiting_response"]).toContain(
    row.status,
  );
  expect(row.expiresAt!).toBeGreaterThan(before + 24 * 60 * 60_000);
});

test("Send now on a waiting child no longer approved refuses it and says why", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
  await expect(
    sendQueuedPeerPromptNow(
      a.child,
      peerPromptQueueField(a.child).queuedPeerPrompts![0]!.id,
    ),
  ).rejects.toThrow(/^Not started: the approved runtime .* is disabled\.$/);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(noticeKeys(coord)).toEqual([`held-start:${a.rowId}`]);
});

/* ------------------------------ cancellation ----------------------------- */

test("a deleted coordinator's or child's held rows are cancelled silently", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  sessionStore.markDeleted(b.child);
  cancelHeldForDeletedSession(b.child);
  expect(statusOf(b.rowId)).toBe("cancelled");
  expect(statusOf(a.rowId)).not.toBe("cancelled");
  sessionStore.markDeleted(coord);
  cancelHeldForDeletedSession(coord);
  expect(statusOf(a.rowId)).toBe("cancelled");
  expect(noticeKeys(coord)).toEqual([]);
});

test("archiving cancels a waiting child's prompt but not what an archived coordinator spawned", async () => {
  const coord = spawner(1);
  running(coord, 1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  sessionStore.setArchived(coord, true);
  cancelHeldForArchivedSessions([coord]);
  expect(statusOf(a.rowId)).toBe("held");
  sessionStore.setArchived(a.child, true);
  cancelHeldForArchivedSessions([a.child]);
  expect(statusOf(a.rowId)).toBe("cancelled");
  // A restore brings nothing back.
  sessionStore.setArchived(a.child, false);
  await flush(coord);
  expect(statusOf(a.rowId)).toBe("cancelled");
  expect(statusOf(b.rowId)).toBe("held");
  expect(noticeKeys(coord)).toEqual([]);
});

test("cleanup needs no free slot: a pass with the cap full cancels what was removed out of band", async () => {
  const coord = spawner(1);
  running(coord, 1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  sessionStore.setArchived(a.child, true);
  await startHeldDirectPeers(coord);
  expect(statusOf(a.rowId)).toBe("cancelled");
  expect(statusOf(b.rowId)).toBe("held");
  sessionStore.markDeleted(coord);
  await startHeldDirectPeers(coord);
  expect(statusOf(b.rowId)).toBe("cancelled");
  expect(noticeKeys(coord)).toEqual([]);
});

/* -------------------------- the session list sees it -------------------------- */

/** How many session-list rebuilds `action` asked for, once its effects settled. */
async function listBroadcastsDuring(action: () => unknown): Promise<number> {
  await settle();
  const spy = vi.spyOn(fakeHub, "broadcastSessions");
  try {
    await action();
    await settle();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

const positionOf = (child: string) =>
  held.waitingForSlotByChild().get(child)?.position;

test("every held transition asks the session list to rebuild", async () => {
  const coord = spawner(1);
  const [busy] = running(coord, 1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  const c = waiting(coord, "C");
  const d = waiting(coord, "D");
  const e = waiting(coord, "E");
  const late = session("Late");
  expect(
    await listBroadcastsDuring(() =>
      peerPrompt.sendPeerPrompt({
        senderSessionId: coord,
        targetSessionId: late,
        prompt: "start when there is room",
        responseRequested: false,
        hold: { queueSeq: peerPromptStore.allocateQueueSeq() },
      }),
    ),
    "held insertion",
  ).toBeGreaterThan(0);
  states.set(busy!, "idle");
  expect(
    await listBroadcastsDuring(() => startHeldDirectPeers(coord)),
    "promotion",
  ).toBeGreaterThan(0);
  expect(statusOf(a.rowId)).toBe("queued");
  expect(
    await listBroadcastsDuring(() =>
      withdrawQueuedPeerPrompt(
        b.child,
        peerPromptQueueField(b.child).queuedPeerPrompts![0]!.id,
      ),
    ),
    "withdraw",
  ).toBeGreaterThan(0);
  expect(
    await listBroadcastsDuring(() =>
      cancelQueuedPeerPrompts({
        recipientSessionId: c.child,
        senderSessionId: coord,
        reason: "Stopped by the coordinator.",
      }),
    ),
    "cancel",
  ).toBeGreaterThan(0);
  sessionStore.markDeleted(d.child);
  expect(
    await listBroadcastsDuring(() => cancelHeldForDeletedSession(d.child)),
    "delete",
  ).toBeGreaterThan(0);
  sessionStore.setArchived(e.child, true);
  expect(
    await listBroadcastsDuring(() => cancelHeldForArchivedSessions([e.child])),
    "archive",
  ).toBeGreaterThan(0);
  for (const id of [b.rowId, c.rowId, d.rowId, e.rowId])
    expect(statusOf(id)).toBe("cancelled");
  expect(positionOf(late)).toBe(1);
});

test("a refused start asks the session list to rebuild", async () => {
  const coord = spawner(1);
  const a = waiting(coord, "A");
  updateSettings({ peerSpawnRuntimes: [runtimeRow({ enabled: false })] });
  expect(
    await listBroadcastsDuring(() => startHeldDirectPeers(coord)),
  ).toBeGreaterThan(0);
  expect(statusOf(a.rowId)).toBe("failed");
  expect(positionOf(a.child)).toBeUndefined();
});

test("Send now on a waiting child updates the list before its delivery is appended", async () => {
  const coord = spawner(1);
  running(coord, 1);
  const a = waiting(coord, "A");
  const b = waiting(coord, "B");
  expect([positionOf(a.child), positionOf(b.child)]).toEqual([1, 2]);
  fakeDrivers.set(a.child, new FakeRuntimeDriver(a.child));
  drains.mockRestore();
  // The await every prompt passes before its transcript append.
  const skills = await import("./sessionSkills.ts");
  const realSkills = skills.sessionSkills;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.spyOn(skills, "sessionSkills").mockImplementation(async (...args) => {
    await gate;
    return realSkills(...args);
  });
  await settle();
  const lists = vi.spyOn(fakeHub, "broadcastSessions");
  const sending = sendQueuedPeerPromptNow(
    a.child,
    peerPromptQueueField(a.child).queuedPeerPrompts![0]!.id,
  );
  try {
    await vi.waitFor(() => expect(statusOf(a.rowId)).toBe("dispatching"));
    await settle();
    expect(lists).toHaveBeenCalled();
    const { listSessions } = await import("./sessions.ts");
    const rows = await listSessions([], () => Date.now(), {
      onlyIds: new Set([a.child, b.child]),
    });
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row(a.child)).toBeDefined();
    expect(row(a.child)?.waitingForSlot).toBeUndefined();
    expect(row(b.child)?.waitingForSlot).toEqual({ position: 1 });
  } finally {
    release();
    await sending;
  }
});

/** The real definition reader over a stand-in library whose source can change. */
async function realAgentReader(onModels: (call: number) => void) {
  const authoring = await import("./library/libraryAuthoring.ts");
  const scanner = await import("./library/libraryScanner.ts");
  const runtimeChecks = await import("./agents/agentRuntime.ts");
  const { formatAgentManifest } = await import("./agents/agentLibrary.ts");
  const definition = (persona: string) =>
    formatAgentManifest({
      name: "test-reviewer",
      description: "Reviewer",
      persona,
      models: [MODEL.id],
      effort: "medium",
      denyTools: [],
      skills: [],
      body: "Review.",
    } as never);
  const state = { source: definition("developer") };
  vi.mocked(agentSpawn.agentDefinitionBlob).mockRestore();
  agentSpawn.setAgentSpawnSourcesForTests({
    library: () =>
      ({
        ensureInitialized: async () => {},
        root: "/unused",
        gitBlobIdOf: async (raw: Buffer) => raw.toString(),
      }) as never,
  });
  vi.spyOn(scanner, "scanLibrary").mockResolvedValue({
    entries: [],
    diagnostics: [],
  } as never);
  vi.spyOn(authoring, "resolveEntrySource").mockImplementation(
    async () =>
      ({
        source: state.source,
        raw: Buffer.from(state.source),
        path: "test-reviewer/AGENT.md",
        truncated: false,
      }) as never,
  );
  let calls = 0;
  runtimeChecks.setAgentRuntimeSourcesForTests({
    models: async () => {
      onModels((calls += 1));
      return [MODEL];
    },
    skillNames: async () => [],
    toolNames: async () => [],
  } as never);
  return {
    edit: (persona: string) => (state.source = definition(persona)),
    restore: () => {
      agentSpawn.setAgentSpawnSourcesForTests(null);
      runtimeChecks.setAgentRuntimeSourcesForTests(null);
    },
  };
}

test("the real reader: a definition edited during its model check refuses the child", async () => {
  const reader = await realAgentReader(() => reader.edit("assistant"));
  try {
    const coord = spawner(1);
    const a = waiting(coord, "A", AGENT);
    await startHeldDirectPeers(coord);
    expect(statusOf(a.rowId)).toBe("failed");
  } finally {
    reader.restore();
  }
});

test("the real reader: a definition edited while the slots are counted refuses the child", async () => {
  const reader = await realAgentReader(() => {});
  let sweeps = 0;
  vi.mocked(inspection.runtimeStateReader).mockImplementation(async () => {
    if (++sweeps === 2) reader.edit("assistant");
    return () => "idle";
  });
  try {
    const coord = spawner(1);
    const a = waiting(coord, "A", AGENT);
    await startHeldDirectPeers(coord);
    expect(sweeps).toBeGreaterThanOrEqual(2);
    expect(statusOf(a.rowId)).toBe("failed");
  } finally {
    reader.restore();
  }
});

test("the real reader: an unchanged definition still starts the child", async () => {
  const reader = await realAgentReader(() => {});
  try {
    const coord = spawner(1);
    const a = waiting(coord, "A", AGENT);
    await startHeldDirectPeers(coord);
    expect(statusOf(a.rowId)).toBe("queued");
  } finally {
    reader.restore();
  }
});
