import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type {
  BackgroundWorkBackendEvents,
  BackgroundWorkBackendPort,
  BackgroundWorkCompletion,
  BackgroundWorkHostCloseAck,
  BackgroundWorkHostCloseRequest,
  BackgroundWorkLaunchAck,
  BackgroundWorkLaunchRequest,
  BackgroundWorkProviderBinding,
  BackgroundWorkStopAck,
  BackgroundWorkStopAllAck,
  BackgroundWorkStopAllRequest,
  BackgroundWorkStopRequest,
  BackgroundWorkTarget,
} from "./backends.ts";
import type { Harness } from "@assistant/shared";
import type {
  BackgroundWorkAdmission,
  BackgroundWorkAdmissionRequest,
  BackgroundWorkDenialReason,
  BackgroundWorkFrozenPolicy,
} from "./service.ts";

const dataDir = mkdtempSync(join(tmpdir(), "background-work-service-test-"));
process.env.DATA_DIR = dataDir;
process.env.ASSISTANT_CWD = dataDir;

const { admitBackgroundWork } = await import("./service.ts");
const { resolveBackgroundWorkSettings } = await import("./settings.ts");
const { updateSettings } = await import("../settings.ts");
const { backgroundWorkStore } = await import("../db/backgroundWorkStore.ts");
const { sessionStore } = await import("../db/sessionStore.ts");

let serial = 0;
/**
 * The harness decides which background backend the session may own, so the
 * default is pi — the `host-process` backend most of this file admits.
 */
function makeSession(
  scope: "user" | "internal" = "user",
  harness: Harness = "pi",
): string {
  serial += 1;
  const id = `svc-${scope}-${serial}`;
  sessionStore.upsert({ id, scope, harness, agentType: "developer" });
  return id;
}

/**
 * What a caller hands a backend: the frozen policy, never live settings. An
 * item with no host epoch has no grace to pass, and 0 is the honest stand-in.
 */
function launchRequestFor(
  target: BackgroundWorkTarget,
  frozen: BackgroundWorkFrozenPolicy,
): BackgroundWorkLaunchRequest {
  return {
    target,
    deadlineAt: frozen.deadlineAt,
    emptyHostGraceMs: frozen.claudeEmptyHostGraceMs ?? 0,
  };
}

function denialReasonOf(
  admission: BackgroundWorkAdmission,
): BackgroundWorkDenialReason | undefined {
  return admission.admitted ? undefined : admission.reason;
}

function request(
  ownerSessionId: string,
  overrides: Partial<BackgroundWorkAdmissionRequest> = {},
): BackgroundWorkAdmissionRequest {
  serial += 1;
  return {
    ownerSessionId,
    backend: "host-process",
    kind: "shell",
    label: "pnpm run test",
    sourceRequestId: `req-${serial}`,
    ...overrides,
  };
}

/** A settings card with a cap set relative to whatever this file already left live. */
function capAt(ownerSessionCap: number): void {
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
}

/**
 * A backend that implements every port and records what it was asked to do.
 * The service does not drive it yet — launch, Stop and completion delivery are
 * later chunks — so this proves the contract is implementable and that an
 * admission carries the frozen values a backend needs.
 */
class FakeBackend implements BackgroundWorkBackendPort {
  readonly backend = "host-process" as const;
  readonly launches: BackgroundWorkLaunchRequest[] = [];
  readonly stops: BackgroundWorkStopRequest[] = [];
  readonly stopAlls: BackgroundWorkStopAllRequest[] = [];
  readonly hostCloses: BackgroundWorkHostCloseRequest[] = [];

  launch(
    launchRequest: BackgroundWorkLaunchRequest,
  ): Promise<BackgroundWorkLaunchAck> {
    this.launches.push(launchRequest);
    const binding: BackgroundWorkProviderBinding = {
      itemId: launchRequest.target.itemId,
      providerTaskId: `fake-${launchRequest.target.itemId}`,
    };
    return Promise.resolve({ launched: true, binding });
  }

  stop(stopRequest: BackgroundWorkStopRequest): Promise<BackgroundWorkStopAck> {
    this.stops.push(stopRequest);
    return Promise.resolve({ acknowledged: true });
  }

  stopAll(
    stopAllRequest: BackgroundWorkStopAllRequest,
  ): Promise<BackgroundWorkStopAllAck> {
    this.stopAlls.push(stopAllRequest);
    return Promise.resolve({
      acknowledgedItemIds: [],
      unconfirmedItemIds: [],
    });
  }

  closeHost(
    closeRequest: BackgroundWorkHostCloseRequest,
  ): Promise<BackgroundWorkHostCloseAck> {
    this.hostCloses.push(closeRequest);
    return Promise.resolve({ closed: true });
  }
}

test("requested lifetime is frozen below Settings and clamped above it", () => {
  capAt(20);
  const shorter = admitBackgroundWork(
    request(makeSession(), {
      sourceRequestId: "requested-shorter",
      requestedLifetimeMs: 12_345,
      now: 1_000,
    }),
  );
  assert.equal(shorter.admitted, true);
  if (!shorter.admitted) return;
  assert.equal(shorter.item.lifetimeMs, 12_345);
  assert.equal(shorter.item.deadlineAt, 13_345);

  const settingsLifetime = resolveBackgroundWorkSettings().taskLifetimeMs;
  const longer = admitBackgroundWork(
    request(makeSession(), {
      sourceRequestId: "requested-longer",
      requestedLifetimeMs: settingsLifetime + 1,
      now: 2_000,
    }),
  );
  assert.equal(longer.admitted, true);
  if (!longer.admitted) return;
  assert.equal(longer.item.lifetimeMs, settingsLifetime);
  assert.equal(longer.item.deadlineAt, 2_000 + settingsLifetime);
});

test("invalid requested lifetime is denied without creating a row", () => {
  capAt(20);
  const owner = makeSession();
  const admission = admitBackgroundWork(
    request(owner, {
      sourceRequestId: "requested-invalid",
      requestedLifetimeMs: 0,
    }),
  );
  assert.equal(denialReasonOf(admission), "invalid-request");
  assert.equal(
    backgroundWorkStore.getItemBySource(owner, "requested-invalid"),
    undefined,
  );
});

test("an admitted item freezes the settings that applied to it", async () => {
  capAt(20);
  const owner = makeSession();
  const settings = resolveBackgroundWorkSettings();
  const admission = admitBackgroundWork(
    request(owner, { sourceRequestId: "frozen-1", now: 1_000 }),
  );
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  assert.equal(admission.item.state, "pending-launch");
  assert.equal(admission.reused, false);
  assert.equal(admission.item.lifetimeMs, settings.taskLifetimeMs);
  assert.equal(admission.item.deadlineAt, 1_000 + settings.taskLifetimeMs);
  assert.equal(admission.item.settingsGeneration, settings.generation);
  // The launch values are read back from the row, so they match it exactly.
  assert.deepEqual(admission.frozen, {
    lifetimeMs: settings.taskLifetimeMs,
    deadlineAt: 1_000 + settings.taskLifetimeMs,
    settingsGeneration: settings.generation,
  });

  // Editing the card does not reach back into work already admitted …
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 5,
      claudeEmptyHostGraceSeconds: 0,
    },
  });
  const stored = backgroundWorkStore.getItem(admission.item.id);
  assert.equal(stored?.deadlineAt, admission.item.deadlineAt);
  assert.equal(stored?.settingsGeneration, settings.generation);

  // … and the NEXT admission gets the new values.
  const next = resolveBackgroundWorkSettings();
  assert.notEqual(next.generation, settings.generation);
  const later = admitBackgroundWork(
    request(owner, { sourceRequestId: "frozen-2", now: 2_000 }),
  );
  assert.equal(later.admitted, true);
  if (!later.admitted) return;
  assert.equal(later.item.deadlineAt, 2_000 + 5 * 60_000);
  assert.equal(later.item.settingsGeneration, next.generation);

  // The frozen values, not live settings, are what a backend is handed.
  const backend = new FakeBackend();
  const target: BackgroundWorkTarget = {
    itemId: admission.item.id,
    ownerSessionId: owner,
    kind: admission.item.kind,
  };
  const ack = await backend.launch(launchRequestFor(target, admission.frozen));
  assert.equal(ack.launched, true);
  assert.equal(backend.launches[0]?.deadlineAt, admission.item.deadlineAt);
});

test("a retry after a settings edit answers with the ORIGINAL frozen values", () => {
  capAt(20);
  const owner = makeSession("user", "claude-sdk");
  const first = admitBackgroundWork(
    request(owner, {
      backend: "claude-query",
      sourceRequestId: "retry-frozen",
      hostEpochKey: `epoch-retry-${owner}`,
      now: 10_000,
    }),
  );
  assert.equal(first.admitted, true);
  if (!first.admitted) return;
  assert.equal(first.reused, false);
  assert.equal(first.frozen.claudeEmptyHostGraceMs, 30_000);
  assert.equal(first.frozen.deadlineAt, 10_000 + 60 * 60_000);

  // Move every governing value, then retry the SAME request identity.
  updateSettings({
    backgroundWork: {
      enabled: true,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 5,
      claudeEmptyHostGraceSeconds: 300,
    },
  });
  const live = resolveBackgroundWorkSettings();
  assert.notEqual(live.generation, first.frozen.settingsGeneration);

  const retry = admitBackgroundWork(
    request(owner, {
      backend: "claude-query",
      sourceRequestId: "retry-frozen",
      hostEpochKey: `epoch-retry-${owner}`,
      now: 99_000,
    }),
  );
  assert.equal(retry.admitted, true);
  if (!retry.admitted) return;
  assert.equal(retry.reused, true, "a retry reserves nothing new");
  assert.equal(retry.item.id, first.item.id);
  // Every launch value is the one frozen on the row, NOT the live snapshot.
  assert.deepEqual(retry.frozen, first.frozen);
  assert.notEqual(retry.frozen.settingsGeneration, live.generation);
  assert.notEqual(
    retry.frozen.claudeEmptyHostGraceMs,
    live.claudeEmptyHostGraceMs,
  );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner }).length,
    1,
    "the retry created no second row",
  );
  capAt(20);
});

test("a retry after the feature is disabled still answers with its live row", () => {
  capAt(20);
  const owner = makeSession();
  const first = admitBackgroundWork(
    request(owner, { sourceRequestId: "retry-disabled", now: 20_000 }),
  );
  assert.equal(first.admitted, true);
  if (!first.admitted) return;

  updateSettings({
    backgroundWork: {
      enabled: false,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  // A NEW request is refused …
  assert.equal(
    denialReasonOf(
      admitBackgroundWork(request(owner, { sourceRequestId: "after-disable" })),
    ),
    "disabled",
  );
  // … but the retry is about a row that is still `pending-launch`, and telling
  // its caller "disabled" would strand work nothing would ever launch or stop.
  const retry = admitBackgroundWork(
    request(owner, { sourceRequestId: "retry-disabled", now: 30_000 }),
  );
  assert.equal(retry.admitted, true);
  if (!retry.admitted) return;
  assert.equal(retry.reused, true);
  assert.equal(retry.item.id, first.item.id);
  assert.deepEqual(retry.frozen, first.frozen);
  capAt(20);
});

test("a retry never resurrects work that already ended", () => {
  capAt(20);
  const owner = makeSession();
  const first = admitBackgroundWork(
    request(owner, { sourceRequestId: "retry-stopped" }),
  );
  assert.equal(first.admitted, true);
  if (!first.admitted) return;
  // A Stop that wins the pre-launch race terminalizes the row.
  backgroundWorkStore.requestStop({
    itemId: first.item.id,
    reason: "owner stopped it",
    sourceRequestId: "stop-1",
  });

  const retry = admitBackgroundWork(
    request(owner, { sourceRequestId: "retry-stopped" }),
  );
  assert.equal(retry.admitted, true);
  if (!retry.admitted) return;
  assert.equal(retry.reused, true);
  assert.equal(retry.item.id, first.item.id);
  // The caller sees the terminal state rather than a fresh reservation.
  assert.equal(retry.item.state, "not-started");
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner }).length,
    1,
  );
});

test("a session may not admit the other harness's backend", () => {
  capAt(20);
  const pi = makeSession("user", "pi");
  const claude = makeSession("user", "claude-sdk");

  const piWantsClaude = admitBackgroundWork(
    request(pi, {
      backend: "claude-query",
      sourceRequestId: "pi-wants-claude",
      hostEpochKey: `epoch-${pi}`,
    }),
  );
  assert.equal(denialReasonOf(piWantsClaude), "ineligible-owner");
  assert.deepEqual(backgroundWorkStore.listItems({ ownerSessionId: pi }), []);
  assert.equal(backgroundWorkStore.hostForOwner(pi), undefined);

  const claudeWantsProcess = admitBackgroundWork(
    request(claude, {
      backend: "host-process",
      sourceRequestId: "claude-wants-process",
    }),
  );
  assert.equal(denialReasonOf(claudeWantsProcess), "ineligible-owner");
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: claude }),
    [],
  );
});

test("the same owner's later children reuse its one slot", () => {
  capAt(20);
  const owner = makeSession();
  const before = backgroundWorkStore.ownerSlotCount();
  const first = admitBackgroundWork(request(owner, { sourceRequestId: "a" }));
  const second = admitBackgroundWork(request(owner, { sourceRequestId: "b" }));
  assert.equal(first.admitted, true);
  assert.equal(second.admitted, true);
  assert.equal(backgroundWorkStore.ownerSlotCount(), before + 1);
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner, state: "active" })
      .length,
    2,
  );
});

test("the disabled switch denies admission and creates no row", () => {
  const owner = makeSession();
  updateSettings({
    backgroundWork: {
      enabled: false,
      ownerSessionCap: 20,
      taskLifetimeMinutes: 60,
      claudeEmptyHostGraceSeconds: 30,
    },
  });
  const denial = admitBackgroundWork(
    request(owner, { sourceRequestId: "while-disabled" }),
  );
  assert.equal(denialReasonOf(denial), "disabled");
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: owner }),
    [],
  );
  capAt(20);
});

test("an ineligible owner is denied before anything is reserved", () => {
  capAt(20);
  const internal = makeSession("internal");
  const denial = admitBackgroundWork(
    request(internal, { sourceRequestId: "internal-1" }),
  );
  assert.equal(denialReasonOf(denial), "ineligible-owner");
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: internal }),
    [],
  );

  const unknown = admitBackgroundWork(
    request("never-persisted", { sourceRequestId: "unknown-1" }),
  );
  assert.equal(denialReasonOf(unknown), "ineligible-owner");
});

test("the final slot admits one owner and refuses the next, with no row", () => {
  // Sequential, and named for what it proves. ATOMICITY is not tested here and
  // cannot be from this process: `node:sqlite` and the singleton connection are
  // synchronous, so two admissions cannot interleave. It rests on `reserveItem`
  // claiming the slot and inserting inside one `mutation`, whose
  // `withDbTransaction` is `BEGIN IMMEDIATE` — covered by Task-482's own store
  // tests.
  //
  // The cap is set relative to what is already live, so the two owners below
  // are competing for one genuinely final slot. Asserted, because the card
  // clamps: a cap that silently landed elsewhere would test nothing.
  const lastSlotCap = backgroundWorkStore.ownerSlotCount() + 1;
  capAt(lastSlotCap);
  assert.equal(resolveBackgroundWorkSettings().ownerSessionCap, lastSlotCap);
  const winner = makeSession();
  const loser = makeSession();
  const results = [winner, loser].map((owner) =>
    admitBackgroundWork(request(owner, { sourceRequestId: `race-${owner}` })),
  );
  const admitted = results.filter((result) => result.admitted);
  assert.equal(admitted.length, 1, "exactly one admission takes the last slot");
  const refused = results.find((result) => !result.admitted);
  assert.equal(refused && denialReasonOf(refused), "at-capacity");
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: loser }),
    [],
  );
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: winner, state: "active" })
      .length,
    1,
  );

  // The owner that DID win keeps admitting: the cap counts sessions, and its
  // slot is already held.
  const child = admitBackgroundWork(
    request(winner, { sourceRequestId: "race-child" }),
  );
  assert.equal(child.admitted, true);
  capAt(20);
});

test("a malformed request is a bounded denial, not a throw", () => {
  capAt(20);
  const owner = makeSession("user", "claude-sdk");
  // Claude work without its retained epoch could never be bound or stopped.
  const denial = admitBackgroundWork(
    request(owner, { backend: "claude-query", sourceRequestId: "no-host" }),
  );
  assert.equal(denialReasonOf(denial), "invalid-request");
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: owner }),
    [],
  );
});

test("a blank request identity is a denial, not a throw", () => {
  capAt(20);
  const owner = makeSession();
  // The store bounds the request identity wherever it first touches one, and
  // the retry lookup touches it BEFORE the reservation does. A validation that
  // escaped the denial mapping would throw at a caller the contract promised a
  // bounded answer to.
  for (const sourceRequestId of ["", " ", "\t\n"]) {
    const denial = admitBackgroundWork(request(owner, { sourceRequestId }));
    assert.equal(
      denialReasonOf(denial),
      "invalid-request",
      `blank id ${JSON.stringify(sourceRequestId)} must be denied`,
    );
  }
  assert.deepEqual(
    backgroundWorkStore.listItems({ ownerSessionId: owner }),
    [],
  );
});

test("a Claude admission creates its retained epoch with the frozen grace", () => {
  capAt(20);
  const owner = makeSession("user", "claude-sdk");
  const settings = resolveBackgroundWorkSettings();
  const admission = admitBackgroundWork(
    request(owner, {
      backend: "claude-query",
      kind: "monitor-command",
      sourceRequestId: "claude-1",
      hostEpochKey: `epoch-${owner}`,
    }),
  );
  assert.equal(admission.admitted, true);
  if (!admission.admitted) return;
  const host = backgroundWorkStore.hostForOwner(owner);
  assert.equal(host?.id, admission.item.hostId);
  assert.equal(host?.state, "creating");
  assert.equal(host?.emptyGraceMs, settings.claudeEmptyHostGraceMs);
});

test("an epoch first seen over cap refuses admitted work with no new row", () => {
  capAt(20);
  const owner = makeSession("user", "claude-sdk");
  const epochKey = `epoch-over-cap-${owner}`;
  // Reconciliation records work already executing that nobody admitted. Make
  // the machine demonstrably full first, so the observation lands `over-cap`
  // rather than adopting a free slot — this test must not depend on what the
  // ones before it happened to leave behind.
  const occupied = backgroundWorkStore.ownerSlotCount();
  assert.ok(occupied > 0, "earlier admissions hold at least one slot");
  backgroundWorkStore.observeItem({
    ownerSessionId: owner,
    backend: "claude-query",
    kind: "shell",
    label: "already running",
    sourceRequestId: "observed-over-cap",
    lifetimeMs: 60_000,
    settingsGeneration: 1,
    bootEpoch: "boot-test",
    ownerLimit: occupied,
    host: { epochKey, emptyGraceMs: 0 },
  });
  const before = backgroundWorkStore.listItems({ ownerSessionId: owner });
  assert.equal(before.length, 1);
  assert.equal(before[0]?.provenance, "observed-over-cap");

  // That epoch can never take admitted work, however free the cap is now.
  const denial = admitBackgroundWork(
    request(owner, {
      backend: "claude-query",
      sourceRequestId: "into-over-cap-epoch",
      hostEpochKey: epochKey,
    }),
  );
  assert.equal(denialReasonOf(denial), "host-over-cap");
  assert.equal(
    backgroundWorkStore.listItems({ ownerSessionId: owner }).length,
    1,
    "the refusal created no row",
  );
});

test("a backend reports provider facts through the event port only", () => {
  const seen: Array<BackgroundWorkProviderBinding | BackgroundWorkCompletion> =
    [];
  const events: BackgroundWorkBackendEvents = {
    providerBound: (binding) => void seen.push(binding),
    activity: () => undefined,
    activityRateExceeded: () => undefined,
    outputCaptured: () => undefined,
    completed: (completion) => void seen.push(completion),
  };
  events.providerBound({ itemId: "bgw_1", providerTaskId: "vendor-1" });
  events.activity({
    itemId: "bgw_1",
    lines: ["changed"],
    bytes: 7,
    droppedEventCount: 0,
    eventId: "activity-1",
  });
  events.completed({ itemId: "bgw_1", state: "completed", exitCode: 0 });
  assert.equal(seen.length, 2);
});
