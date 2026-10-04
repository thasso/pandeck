import {
  type AgentType,
  clampThinkingLevelForModel,
  type Harness,
  harnessForModelProvider,
  type ModelOption,
  type PromptAttachment,
  type SessionMode,
  type SessionState,
  type ThinkingLevel,
} from "@assistant/shared";

export interface NewSessionRuntimeDefaults {
  harness: Harness;
  provider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  /**
   * Build/Plan. REQUIRED (though it may be undefined = Build): a staged runtime
   * is assembled at half a dozen call sites, and an optional field there let
   * Plan travel by omission — a mode staged for one session silently applying to
   * the next one. Every site now states the mode it means.
   */
  mode: SessionMode | undefined;
}

export const LEGACY_NEW_SESSION_DRAFT_STORAGE_KEY =
  "assistant.composerDraft.session:new";
export const NEW_SESSION_DRAFT_STORAGE_KEY =
  "assistant.composerDraft.session:new-v2";

/**
 * Storage slot for the composer's browser-local draft.
 *
 * A STAGED session shares one versioned new-session slot for its whole staging
 * phase: it has no server identity yet and its client id is re-minted whenever
 * the user restages (agent, model, provider account), so keying the draft to
 * that id would swap the composer to an empty slot mid-typing.
 */
export function composerDraftStorageKey(
  sessionId: string | null | undefined,
  staged: boolean,
): string {
  // `new-v2` intentionally abandons the old shared new-session draft slot. A
  // pi edit-and-retry bug could persist model-only memory there, and those old
  // prompts are stale even when they were otherwise valid.
  return staged || !sessionId
    ? NEW_SESSION_DRAFT_STORAGE_KEY
    : `assistant.composerDraft.session:${sessionId}`;
}

/** A staged session draft only belongs on the session it was created for. */
export function visibleSessionDraft<T extends { sessionId: string }>(
  draft: T | null | undefined,
  displayedSessionId: string | null | undefined,
): T | null {
  if (!draft || draft.sessionId !== displayedSessionId) return null;
  return draft;
}

/**
 * Carry the visible model/thinking selection across a provider-account switch on
 * the new-session surface, so changing WHO runs the session never silently
 * changes WHAT runs it more than it has to.
 *
 * Same provider (another account of it): the identical model is normally offered
 * again and stays selected. Across providers there is no identity to match on,
 * so the pick travels by POSITION in the user's own model order (the settings
 * order `visibleModels` applies) — the nth model of one provider maps to the nth
 * of the other, clamped to the shorter list. That is deliberately dumb and
 * predictable; a capability-tier guess would silently pick a different model
 * than the row shows.
 *
 * The thinking level rides along through `clampThinkingLevelForModel`, which
 * maps onto the nearest level the destination model actually accepts — that is
 * the clean pi↔Claude mapping (Claude has no `minimal`/`max`, some Claude models
 * have no `off`).
 */
export function carryOverRuntimeSelection<M extends ModelOption>({
  model,
  thinkingLevel,
  fromModels,
  toModels,
}: {
  /** The model the pickers currently show, if any. */
  model: M | undefined;
  thinkingLevel: ThinkingLevel;
  /** Picker models of the account being left, in display order. */
  fromModels: readonly M[];
  /** Picker models of the account being switched to, in display order. */
  toModels: readonly M[];
}): { model: M | undefined; thinkingLevel: ThinkingLevel } {
  const next = carryOverModel(model, fromModels, toModels);
  return {
    model: next,
    thinkingLevel: clampThinkingLevelForModel(next, thinkingLevel),
  };
}

function carryOverModel<M extends ModelOption>(
  model: M | undefined,
  fromModels: readonly M[],
  toModels: readonly M[],
): M | undefined {
  if (toModels.length === 0) return undefined;
  if (!model) return toModels[0];
  const same = toModels.find(
    (candidate) =>
      candidate.provider === model.provider && candidate.id === model.id,
  );
  if (same) return same;
  const index = fromModels.findIndex(
    (candidate) =>
      candidate.provider === model.provider && candidate.id === model.id,
  );
  if (index === -1) return toModels[0];
  return toModels[Math.min(index, toModels.length - 1)];
}

/**
 * Where a composer send goes on the new-session surface.
 *
 * `prompt` is the ordinary path: a message into the session this connection is
 * VIEWING. That makes "is this still a first send?" a safety question rather
 * than a cosmetic one — there is no detach message, so a `prompt` sent while no
 * session has been created yet lands in whatever session was open before, and
 * the browser would not even show it (its optimistic echo carries a different
 * session id).
 *
 * A visible prompt is therefore not enough to conclude the session exists: a
 * first send that FAILED leaves its prompt on screen and may have created
 * nothing — a worktree that could not be checked out, a model the account
 * cannot run — and the next send has to re-issue that held first send instead
 * of falling through. Re-issuing after a failure that DID create a session
 * costs one empty session; letting the prompt fall through costs a turn started
 * in a conversation the user is not looking at, which is not recoverable.
 */
export type ComposerSendRouting =
  "first-send" | "reissue-first-send" | "prompt";

export function routeComposerSend(input: {
  isNewChatRoute: boolean;
  /** A user prompt is visible in the transcript (durable OR optimistic). */
  hasUserPrompt: boolean;
  /** A held first send that failed is waiting to be re-issued. */
  firstSendRetryPending: boolean;
}): ComposerSendRouting {
  if (!input.isNewChatRoute) return "prompt";
  if (input.firstSendRetryPending) return "reissue-first-send";
  return input.hasUserPrompt ? "prompt" : "first-send";
}

/**
 * Build a complete staged runtime from the model shown for a new session.
 *
 * A fresh start is Build. Model and thinking level are remembered preferences,
 * Plan is not: it is chosen for ONE session, so a start from a Task, a worktree
 * or the `/review` handoff begins in Build no matter what the previous staging
 * held. Inheriting it silently put reviewers into a mode nobody picked, on a
 * landing page where the only trace of it is one composer pill.
 */
export function newSessionRuntimeDefaults(
  model: ModelOption | undefined,
  thinkingLevel: ThinkingLevel,
): NewSessionRuntimeDefaults {
  return {
    harness: harnessForModelProvider(model?.provider),
    ...(model?.provider !== undefined ? { provider: model?.provider } : {}),
    ...(model?.id !== undefined ? { modelId: model?.id } : {}),
    thinkingLevel: clampThinkingLevelForModel(model, thinkingLevel),
    mode: undefined,
  };
}

/**
 * The `kind: "new"` session target of a review handoff (`attachComments`).
 *
 * The comment-review handoffs — worktree threads and Knowledge threads — create
 * their session SERVER-side instead of sending a first prompt, so this object,
 * not a `harnessSend`, is where the staged runtime has to arrive COMPLETE. One
 * function for both bundles because two hand-assembled copies drift: Build/Plan
 * reached neither of them for exactly as long as there were two.
 */
export function reviewHandoffSessionTarget(input: {
  /** The runtime the composer displays (`firstPromptRuntimeSelection`). */
  runtime: NewSessionRuntimeDefaults;
  agentType: AgentType;
  credentialProfileId: string;
  /** The user's own prompt; the comment bundle rides along as context. */
  additionalPrompt: string;
  attachments: readonly PromptAttachment[];
}): {
  kind: "new";
  harness: Harness;
  agentType: AgentType;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
  mode?: SessionMode;
  credentialProfileId: string;
  additionalPrompt: string;
  attachments?: PromptAttachment[];
} {
  const { runtime } = input;
  return {
    kind: "new",
    harness: runtime.harness,
    agentType: input.agentType,
    ...(runtime.provider ? { modelProvider: runtime.provider } : {}),
    ...(runtime.modelId ? { modelId: runtime.modelId } : {}),
    thinkingLevel: runtime.thinkingLevel,
    ...(runtime.mode !== undefined ? { mode: runtime.mode } : {}),
    credentialProfileId: input.credentialProfileId,
    additionalPrompt: input.additionalPrompt,
    ...(input.attachments.length
      ? { attachments: [...input.attachments] }
      : {}),
  };
}

/**
 * Resolve the runtime sent with a first prompt from the optimistic session that
 * drives the visible pickers. This keeps the created server session identical
 * to what the composer displays even when its original staging record omitted
 * an explicit model.
 *
 * The harness is DERIVED from that same model rather than read off the staging
 * record: a record staged before the model was known (a Task start that flips
 * the persona, say) carries the "pi" fallback while the pickers show the
 * remembered Claude model, and sending that pair fails server-side with a
 * credential-profile/provider error.
 */
export function firstPromptRuntimeSelection(
  session:
    Pick<SessionState, "model" | "thinkingLevel" | "mode"> | null | undefined,
): NewSessionRuntimeDefaults {
  return {
    harness: harnessForModelProvider(session?.model?.provider),
    ...(session?.model?.provider !== undefined
      ? { provider: session?.model?.provider }
      : {}),
    ...(session?.model?.id !== undefined
      ? { modelId: session?.model?.id }
      : {}),
    thinkingLevel: session?.thinkingLevel ?? "off",
    // Build/Plan rides the same optimistic record the pickers show, so the
    // created session starts in the mode the composer displays.
    mode: session?.mode,
  };
}
