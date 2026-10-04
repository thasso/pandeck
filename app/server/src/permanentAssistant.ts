import type { AgentType, DisplayMessage } from "@assistant/shared";
import {
  CLAUDE_SDK_PROVIDER,
  isPersonalAssistantAgentType,
} from "@assistant/shared";
import {
  permanentAssistantStore,
  type PermanentAssistantQueueItem,
} from "./db/permanentAssistantStore.ts";
import { errorText } from "./errors.ts";
import { createSession } from "./harnesses/create.ts";
import type { HarnessDriver } from "./harness.ts";
import { hub } from "./hub.ts";
import { selectPiModelWithFallback } from "./piSdk/oneShot.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import { getSettings } from "./settings.ts";
import { permanentAssistantProfileInstructions } from "./permanentAssistantProfile.ts";
import { memoryScheduler } from "./memory/memoryScheduler.ts";
import { resetMemorySessionContext } from "./memory/memoryRuntime.ts";
import { accountForSlot } from "./settingsModelSlots.ts";

export interface PermanentAssistantDelivery {
  item: PermanentAssistantQueueItem;
  state: "queued" | "working" | "completed" | "failed";
  response?: string;
  error?: string;
}

type DeliveryListener = (
  delivery: PermanentAssistantDelivery,
) => void | Promise<void>;
const listeners = new Set<DeliveryListener>();
let draining = false;
let stopping = false;

export function permanentAssistantIsBusy(): boolean {
  return draining;
}

export function subscribePermanentAssistant(
  listener: DeliveryListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isPermanentAssistantSession(sessionId: string): boolean {
  return permanentAssistantStore.sessionId() === sessionId;
}

/** The identity a session-list row needs to be recognized as the singleton. */
export interface SessionRowIdentity {
  id: string;
  agentType?: AgentType;
}

/**
 * One store read, then a per-row predicate for the rows no ordinary session
 * list may show. Built once per projection because a list is rebuilt up to ~4
 * times a second — never one binding lookup per row.
 *
 * The singleton is matched by PERSONA, not only by the currently bound id: two
 * other states are real and both used to surface as an ordinary "Personal
 * Assistant" row. A list rebuild can flush in the window between minting the
 * session and binding it, and `rotatePermanentAssistantSession` leaves the
 * predecessor behind after a profile change. The persona exists only behind the
 * dedicated entry point, so neither belongs in a list — and a rotated
 * predecessor pays for that by keeping its history reachable only by id (see
 * `rotatePermanentAssistantSession`).
 *
 * The bound id is still checked so a legacy binding to an `assistant`-typed
 * session stays hidden for as long as it IS the singleton; that row becomes
 * ordinary listed history the moment the binding is abandoned.
 */
export function sessionListHiddenProbe(): (row: SessionRowIdentity) => boolean {
  const boundId = permanentAssistantStore.sessionId();
  return (row) =>
    isPersonalAssistantAgentType(row.agentType) || row.id === boundId;
}

export function hasPermanentAssistantMessage(dedupeKey: string): boolean {
  return permanentAssistantStore.find(dedupeKey) !== undefined;
}

export function enqueuePermanentAssistant(input: {
  dedupeKey: string;
  source: "web" | "slack";
  sourceMetadata?: Record<string, unknown>;
  text: string;
}): PermanentAssistantQueueItem {
  const item = permanentAssistantStore.enqueue(input);
  emit({
    item,
    state:
      item.status === "working"
        ? "working"
        : item.status === "completed"
          ? "completed"
          : item.status === "failed"
            ? "failed"
            : "queued",
  });
  void drainPermanentAssistantQueue();
  return item;
}

export function startPermanentAssistant(): void {
  stopping = false;
  permanentAssistantStore.recover();
  void drainPermanentAssistantQueue();
}

export function stopPermanentAssistant(): void {
  stopping = true;
}

/**
 * Bind the next open/message to a FRESH session. The predecessor is abandoned,
 * never deleted: its conversation stays on disk and in the metadata store, and
 * it is still reachable BY ID — a `/sessions/<id>` deep link loads it, and the
 * session tools still read and search it.
 *
 * It is NOT listed as an ordinary session, though. It remains a
 * `personal-assistant` session, and that persona is hidden from every list
 * (`sessionListHiddenProbe`), while `/assistant` always resolves the currently
 * BOUND singleton. Since the caller is a Personal Assistant profile edit
 * (`connection.ts`'s `onUpdateSettings` rotates on any name/provider/model/
 * thinking/instructions change), that means each such edit leaves the previous
 * conversation intact but with no UI path back to it.
 */
export async function rotatePermanentAssistantSession(): Promise<void> {
  // Synchronously, before anything yields: an acquisition already under way
  // belongs to the old profile and may no longer bind, and one asked for from
  // here on waits for the old singleton to be abandoned first.
  generation += 1;
  // Chained: a rotation still flushing the old singleton finishes first, so
  // its flush precedes every reset, and the last rotation to settle is the
  // one acquisitions waited for.
  const prior = rotation;
  const run = (async () => {
    await prior?.catch(() => {});
    await abandonPermanentAssistant();
  })();
  rotation = run;
  try {
    await run;
  } finally {
    if (rotation === run) rotation = undefined;
  }
}

async function abandonPermanentAssistant(): Promise<void> {
  const previous = permanentAssistantStore.sessionId();
  if (previous) {
    // AWAIT the pending-observation flush and reset the memory snapshot for the
    // old session BEFORE abandoning it, so nothing is lost and the fresh session
    // re-injects a clean snapshot on its first turn. (Observations are durable +
    // keyed by session id, so a budget-deferred flush still resumes later.)
    await memoryScheduler.flushBeforeReset(previous);
    resetMemorySessionContext(previous);
  }
  // Only the singleton this rotation set out to abandon.
  if (permanentAssistantStore.sessionId() === previous)
    permanentAssistantStore.clearSessionId();
}

export async function permanentAssistantSessionId(): Promise<string> {
  return (await acquirePermanentAssistant()).id;
}

/**
 * The bound singleton's id when it can simply be OPENED — a stored
 * `personal-assistant` session that needs no creation and no legacy-binding
 * repair. Opening it is then a read (`hub.viewById`), which is what keeps the
 * Assistant appearing at once instead of after its transcript is parsed.
 *
 * Undefined means the slow path is required: no binding yet, no record, a
 * legacy binding to an ordinary session that {@link acquirePermanentAssistant}
 * has to abandon and replace, or a rotation still abandoning the bound one.
 */
export function permanentAssistantViewableId(): string | undefined {
  if (rotation) return undefined;
  const id = permanentAssistantStore.sessionId();
  if (!id) return undefined;
  return sessionStore.get(id)?.agentType === "personal-assistant"
    ? id
    : undefined;
}

type PermanentAssistantDriver = HarnessDriver & RuntimePromptDriver;

/** Bumped by every rotation: an acquisition from an older one never binds. */
let generation = 0;
/** The rotation abandoning the old singleton, while it runs. */
let rotation: Promise<void> | undefined;
/** The acquisition under way, which every concurrent caller shares. */
let acquiring:
  | { generation: number; promise: Promise<PermanentAssistantDriver> }
  | undefined;

/**
 * The singleton's driver, acquired once however many callers ask at the same
 * time: creation yields before the new session is bound, so two acquisitions
 * that overlapped would each create one, and the later binding would hide the
 * earlier conversation. A rotation meanwhile retires the shared acquisition:
 * what it was creating belongs to the old profile.
 */
function acquirePermanentAssistant(): Promise<PermanentAssistantDriver> {
  if (acquiring?.generation === generation) return acquiring.promise;
  const mine = generation;
  const promise = (async () => {
    // A failed rotation is reported where it was asked for; it does not fail
    // the acquisitions that waited for it.
    await rotation?.catch(() => {});
    // Another rotation began meanwhile: this generation is already retired,
    // so join the current one rather than create a session nothing binds.
    if (mine !== generation) return acquirePermanentAssistant();
    return acquireOrCreatePermanentAssistant(mine);
  })().finally(() => {
    if (acquiring?.promise === promise) acquiring = undefined;
  });
  acquiring = { generation: mine, promise };
  return promise;
}

async function acquireOrCreatePermanentAssistant(
  mine: number,
): Promise<PermanentAssistantDriver> {
  // Whatever this finds or creates after a rotation is the old profile's: the
  // current generation's acquisition answers instead, and an unbound session
  // created here stays behind as empty history.
  const rotated = () => mine !== generation;
  const existingId = permanentAssistantStore.sessionId();
  if (existingId) {
    const existing = await hub.acquireById(existingId);
    if (rotated()) return acquirePermanentAssistant();
    // Reuse the bound singleton only when it is a real `personal-assistant`
    // session. A legacy binding to an ordinary `assistant` session (created
    // before this persona existed) is abandoned WITHOUT deleting it: the old
    // conversation stays intact and recoverable as ordinary session history,
    // and a fresh Personal Assistant singleton is acquired below.
    if (existing && "createRuntimeAdapter" in existing) {
      if (existing.agentType === "personal-assistant")
        return existing as unknown as PermanentAssistantDriver;
      permanentAssistantStore.clearSessionId();
    }
  }

  const profile = getSettings().permanentAssistant;
  const profileInstructions = permanentAssistantProfileInstructions(profile);
  const credentialProfileId = accountForSlot(profile);
  let driver: PermanentAssistantDriver;
  if (
    profile.provider === CLAUDE_SDK_PROVIDER &&
    getSettings().claudeSdk.enabled
  ) {
    driver = await createSession({
      harness: "claude-sdk",
      agentType: "personal-assistant",
      modelId: profile.modelId,
      thinkingLevel: profile.thinkingLevel,
      additionalSystemPrompt: profileInstructions,
      credentialProfileId,
    });
  } else {
    const model = await selectPiModelWithFallback(profile, credentialProfileId);
    if (!model)
      throw new Error(
        "No model is available for the permanent Personal Assistant",
      );
    driver = await createSession({
      harness: "pi",
      agentType: "personal-assistant",
      model,
      thinkingLevel: profile.thinkingLevel,
      credentialProfileId,
    });
  }
  if (rotated()) return acquirePermanentAssistant();
  permanentAssistantStore.setSessionId(driver.id);
  return driver;
}

async function drainPermanentAssistantQueue(): Promise<void> {
  if (draining || stopping) return;
  draining = true;
  try {
    while (!stopping) {
      const item = permanentAssistantStore.next();
      if (!item) break;
      permanentAssistantStore.mark(item.id, "working");
      emit({
        item: { ...item, status: "working", attempts: item.attempts + 1 },
        state: "working",
      });
      try {
        const driver = await acquirePermanentAssistant();
        const beforeIds = new Set(
          driver.snapshot().map((message) => message.id),
        );
        await promptRuntimeSession(driver, item.text, {
          clientRequestId:
            item.source === "web" &&
            typeof item.sourceMetadata.clientRequestId === "string"
              ? item.sourceMetadata.clientRequestId
              : `permanent-assistant:${item.id}`,
          origin: { kind: "human" },
        });
        const response = latestAssistantText(driver.snapshot(), beforeIds);
        permanentAssistantStore.mark(item.id, "completed");
        emit({
          item: { ...item, status: "completed" },
          state: "completed",
          response,
        });
      } catch (error) {
        const message = errorText(error);
        permanentAssistantStore.mark(item.id, "failed", message);
        emit({
          item: { ...item, status: "failed", error: message },
          state: "failed",
          error: message,
        });
      }
    }
  } finally {
    draining = false;
  }
}

function latestAssistantText(
  messages: DisplayMessage[],
  beforeIds: Set<string>,
): string {
  const message = [...messages]
    .reverse()
    .find((entry) => entry.role === "assistant" && !beforeIds.has(entry.id));
  if (!message)
    return "The Assistant completed the request without a text response.";
  return (
    message.blocks
      .filter(
        (
          block,
        ): block is Extract<
          (typeof message.blocks)[number],
          { kind: "text" }
        > => block.kind === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim() || "The Assistant completed the request without a text response."
  );
}

function emit(delivery: PermanentAssistantDelivery): void {
  for (const listener of listeners)
    Promise.resolve(listener(delivery)).catch((error) =>
      console.warn(
        "[permanent-assistant] delivery listener failed:",
        errorText(error),
      ),
    );
}
