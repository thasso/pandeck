/**
 * "Continue on <model>" (`docs/session-runtime-switching.md` "Continue on
 * another model"): what a turn's terminal quota or rate-limit failure offers
 * once same-kind failover (`sessionAccountSwitch.ts`) could not recover it,
 * and the user's click that takes the offer.
 *
 * The offer is a list of models another engine can continue the turn on, the
 * default first, stored beside the failure it belongs to and cleared with it.
 * Nothing here ever runs on its own: only the user's click sets the pending
 * selection and starts the continuation, which applies it like any new turn.
 */
import {
  clampThinkingLevelForModel,
  modelKey,
  type AppSettings,
  type ModelOption,
  type SessionContinueChoice,
} from "@assistant/shared";
import { pickAccount } from "./accountRouter.ts";
import type { HumanResumeToken } from "./automaticTurnHold.ts";
import { credentialProfileById } from "./credentialProfiles.ts";
import { sessionStore, type SessionMeta } from "./db/sessionStore.ts";
import { pickerModels } from "./harnesses/models.ts";
import { isPermanentAssistantSession } from "./permanentAssistant.ts";
import { resumePromptQueueForHumanPrompt } from "./promptQueue.ts";
import {
  subscribeSessionRunStarted,
  subscribeSessionRunTerminallyFailed,
  type RunFailureReport,
} from "./session/runtime/liveSession.ts";
import {
  promptRuntimeSession,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import {
  accountOffersSelection,
  sessionSelection,
} from "./sessionAccountMove.ts";
import {
  crossesEngines,
  setSessionPendingRuntime,
} from "./sessionPendingRuntime.ts";
import { getSettings } from "./settings.ts";

/** At most this many models are offered: a default and a few alternatives. */
const MAX_CHOICES = 4;

/** What the continuation tells the model; the same words recovery uses. */
const CONTINUE_CONTEXT =
  "Continue the interrupted turn from the existing conversation. Do not repeat completed actions.";

/** Session id → the run whose failure an offer is being computed for. */
const latestFailedRun = new Map<string, string>();

/** The list rows changed: send them now, as other failure writers do. */
function publishRows(): void {
  void import("./stateTopics.ts").then(({ publishSessionRowsNow }) =>
    publishSessionRowsNow(),
  );
}

/**
 * Offer "Continue on" for every terminal quota or rate-limit failure of a
 * user session. Called once at boot; the returned uninstall is for tests.
 */
export function installContinueOffers(): () => void {
  const offTerminal = subscribeSessionRunTerminallyFailed((report) => {
    void offerFor(report).catch((err: unknown) =>
      console.warn("[continue-on] could not compute an offer:", err),
    );
  });
  // A new run supersedes the failure, and with it any offer still computing.
  const offStarted = subscribeSessionRunStarted((sessionId) =>
    latestFailedRun.delete(sessionId),
  );
  return () => {
    offTerminal();
    offStarted();
    latestFailedRun.clear();
  };
}

async function offerFor(report: RunFailureReport): Promise<void> {
  const kind = report.failure?.kind;
  if (kind !== "quota" && kind !== "rate_limit") return;
  const { sessionId, runId } = report;
  const row = sessionStore.get(sessionId);
  if (!row || row.scope !== "user" || isPermanentAssistantSession(sessionId))
    return;
  latestFailedRun.set(sessionId, runId);
  // The failure's own record (`sessionActivity.ts`, on the run's error
  // status) lands later in this same synchronous stack, or before it for a
  // deferred settlement; a run start clears an older one. So once this stack
  // unwound, and before anything else is awaited, the row's failure is this
  // turn's: the offer attaches to that failure or to none.
  await Promise.resolve();
  const failureAt = sessionStore.get(sessionId)?.lastError?.at;
  if (failureAt === undefined || latestFailedRun.get(sessionId) !== runId)
    return;
  const choices = await continueChoices(sessionId);
  if (latestFailedRun.get(sessionId) !== runId) return;
  latestFailedRun.delete(sessionId);
  if (choices.length === 0) return;
  if (sessionStore.recordContinueOffer(sessionId, failureAt, choices))
    publishRows();
}

/** The picker's models as the user arranged them: hidden ones out, in order. */
function arranged(models: ModelOption[], settings: AppSettings): ModelOption[] {
  const hidden = new Set(settings.models.hidden);
  const rank = new Map(settings.models.order.map((key, i) => [key, i]));
  return models
    .filter((model) => !hidden.has(modelKey(model)))
    .sort(
      (a, b) =>
        (rank.get(modelKey(a)) ?? Infinity) -
        (rank.get(modelKey(b)) ?? Infinity),
    );
}

/**
 * What the click's Automatic account resolves to (`sessionPendingRuntime.ts`):
 * the router's non-degraded pick of the model's kind, within the session's
 * enterprise requirement, that offers this model and effort. An offer the
 * click would refuse is never made.
 */
async function runnableNow(
  row: Pick<SessionMeta, "requiresEnterprise">,
  model: ModelOption,
  thinkingLevel: SessionContinueChoice["thinkingLevel"],
): Promise<boolean> {
  const pick = await pickAccount({
    model: { provider: model.provider, modelId: model.id },
    thinkingLevel,
    requiresEnterprise: row.requiresEnterprise === true,
  });
  const profile =
    pick.profileId && !pick.degraded
      ? credentialProfileById(pick.profileId)
      : undefined;
  return (
    profile !== undefined &&
    (await accountOffersSelection(profile, { model, thinkingLevel }))
  );
}

/**
 * The models another engine could continue the session on now, in the user's
 * order with the default first: the model at the failed one's position among
 * its own kind's (the rule the new-session page carries a selection across
 * accounts by). Empty when none can.
 */
export async function continueChoices(
  sessionId: string,
): Promise<SessionContinueChoice[]> {
  const row = sessionStore.get(sessionId);
  if (!row) return [];
  const current = await sessionSelection(row);
  if (!current?.model) return [];
  const source = row.credentialProfileId
    ? credentialProfileById(row.credentialProfileId)
    : undefined;
  const settings = getSettings();
  const visible = arranged(pickerModels(settings), settings);
  const effort = current.thinkingLevel ?? "off";
  const choices: SessionContinueChoice[] = [];
  for (const model of visible) {
    if (!crossesEngines(row, source, model)) continue;
    const thinkingLevel = clampThinkingLevelForModel(model, effort);
    if (!(await runnableNow(row, model, thinkingLevel))) continue;
    choices.push({
      provider: model.provider,
      id: model.id,
      name: model.name,
      thinkingLevel,
    });
  }
  if (choices.length === 0) return [];
  const failed = current.model;
  const own = visible.filter((model) => model.provider === failed.provider);
  const position = own.findIndex((model) => model.id === failed.id);
  const preferred =
    choices[Math.min(Math.max(position, 0), choices.length - 1)]!;
  return [preferred, ...choices.filter((choice) => choice !== preferred)].slice(
    0,
    MAX_CHOICES,
  );
}

/** The user took an offer whose failure is gone or no longer lists the model. */
export class ContinueOfferGoneError extends Error {}

/**
 * The user's "Continue on <model>": the failure they saw (`failureAt`) must
 * still be the session's and still offer `model`, and the session idle, at
 * the write itself. Sets the pending selection to it (Automatic account)
 * without offering held work its turn, and with that write starts the
 * continuation of the failed turn: no user row, the user's
 * authority past a Stop (`resumeHold`), admitted ahead of queued work, which
 * follows on the new engine. Resolves when the continuation reached the
 * provider; rejects with why nothing ran.
 */
export async function continueOnModel(
  driver: RuntimePromptDriver,
  request: {
    failureAt: number;
    model: { provider: string; id: string };
    resumeHold: HumanResumeToken | undefined;
  },
): Promise<void> {
  const sessionId = driver.sessionId;
  const choice = stillOffered(driver, request);
  let continued: Promise<void> | undefined;
  await setSessionPendingRuntime(
    sessionId,
    {
      model: { provider: choice.provider, id: choice.id },
      thinkingLevel: choice.thinkingLevel,
      account: { kind: "automatic" },
    },
    "user",
    {
      wake: false,
      // Asked again with the write itself: a run that started, a Dismiss or a
      // newer failure while the target resolved retired the offer, and a
      // retired offer writes nothing.
      authorize: () => {
        stillOffered(driver, request);
      },
      // In the same synchronous step as that write, the continuation claims
      // the session's admission, so nothing else starts a turn between them.
      written: () => {
        continued = startContinuation(driver, request.resumeHold);
      },
    },
  );
  if (!continued)
    throw new ContinueOfferGoneError(
      "This failure no longer offers that model.",
    );
  await continued;
}

/**
 * The continuation of the failed turn: no user row, the user's authority past
 * a Stop (`resumeHold`), the selection applied at its admission. Resolves when
 * it reached the provider; rejects with why nothing ran.
 */
function startContinuation(
  driver: RuntimePromptDriver,
  resumeHold: HumanResumeToken | undefined,
): Promise<void> {
  const sessionId = driver.sessionId;
  const receipt = promptRuntimeSession(driver, "", {
    hidden: true,
    continuation: true,
    origin: { kind: "human" },
    contextBlock: CONTINUE_CONTEXT,
    ...(resumeHold?.sessionId === sessionId ? { resumeHold } : {}),
  });
  const reached = new Promise<void>((resolve, reject) => {
    let answered = false;
    receipt.observe((event) => {
      if (answered || event.type !== "provider-called") return;
      answered = true;
      // The user's own continuation lifts a Stop's hold on their queue too;
      // what waits there runs after it, on the engine it moved to.
      resumePromptQueueForHumanPrompt(sessionId);
      resolve();
    });
    receipt.then(
      () => {
        if (!answered) {
          answered = true;
          resolve();
        }
      },
      (err: unknown) => {
        if (answered) return;
        answered = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
  // Awaited once the write's announcement is out; never an unhandled rejection
  // meanwhile.
  reached.catch(() => {});
  return reached;
}

/** The offer the click names, while the session is idle and still offers it. */
function stillOffered(
  driver: RuntimePromptDriver,
  request: { failureAt: number; model: { provider: string; id: string } },
): SessionContinueChoice {
  const choice = currentChoice(driver.sessionId, request);
  if (driver.isRunning)
    throw new ContinueOfferGoneError("The session is already running again.");
  return choice;
}

function currentChoice(
  sessionId: string,
  request: { failureAt: number; model: { provider: string; id: string } },
): SessionContinueChoice {
  const failure = sessionStore.get(sessionId)?.lastError;
  const choice =
    failure?.at === request.failureAt
      ? failure.continueOn?.find(
          (option) =>
            option.provider === request.model.provider &&
            option.id === request.model.id,
        )
      : undefined;
  if (!choice)
    throw new ContinueOfferGoneError(
      "This failure no longer offers that model.",
    );
  return choice;
}
