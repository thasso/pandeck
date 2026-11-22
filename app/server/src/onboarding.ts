/**
 * First-run onboarding state (`docs/onboarding.md`): the server, not a
 * browser's view of the accounts, decides whether this install is on its
 * first run.
 *
 * `onboarding.json` under `DATA_DIR` holds `pending`, `setup` or `complete`.
 * Without the file, boot decides once: an install is fresh only when it has no
 * app settings file, no session rows and no credential profiles, and is not a
 * gateway client (whose accounts arrive from a remote gateway after boot).
 * Everything else is `complete`, so an established install never sees first
 * run. `complete` is final.
 *
 * While `pending`, the server moves to `setup` itself the moment it sees a
 * usable account (enabled, signed in, offering a model). In the same step it
 * runs the Personal Assistant on that account when its model slot cannot run,
 * and names it "Larry" when no name is saved. A `pending` install has memory
 * off: persisted from boot on (unless a memory setting was saved), and
 * enforced while `pending`, so the setup conversation's Memory step is an
 * opt-in.
 * `setup` lasts until the user (or the assistant, on their word) finishes the
 * guided setup conversation.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  accountServesModel,
  CLAUDE_SDK_PROVIDER,
  clampThinkingLevelForModel,
  DEFAULT_HELPER_MODEL,
  DEFAULT_PERMANENT_ASSISTANT_NAME,
  FIRST_RUN_ASSISTANT_NAME,
  type CredentialProfileProvider,
  type ModelOption,
  type OnboardingState,
  type ServerMessage,
  type ThinkingLevel,
} from "@assistant/shared";
import { readStoredAppSettings } from "./appSettingsFile.ts";
import { DATA_DIR } from "./config.ts";
import { errorText } from "./errors.ts";

const ONBOARDING_PATH = join(DATA_DIR, "onboarding.json");

/** What boot knows about an install that has no onboarding file yet. */
export interface InstallFacts {
  settingsFile: boolean;
  sessions: boolean;
  accounts: boolean;
  gatewayClient: boolean;
}

/** Fresh only when nothing at all says the install was used before. */
export function initialOnboardingState(facts: InstallFacts): OnboardingState {
  return facts.settingsFile ||
    facts.sessions ||
    facts.accounts ||
    facts.gatewayClient
    ? "complete"
    : "pending";
}

let state: OnboardingState | undefined;
let broadcast: ((message: ServerMessage) => void) | undefined;

function writeState(next: OnboardingState): void {
  mkdirSync(dirname(ONBOARDING_PATH), { recursive: true, mode: 0o700 });
  const tmp = `${ONBOARDING_PATH}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ state: next })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, ONBOARDING_PATH);
}

function readState(): OnboardingState {
  try {
    const parsed = JSON.parse(readFileSync(ONBOARDING_PATH, "utf8")) as {
      state?: unknown;
    };
    if (
      parsed?.state === "pending" ||
      parsed?.state === "setup" ||
      parsed?.state === "complete"
    )
      return parsed.state;
  } catch (err) {
    console.warn(`[onboarding] unreadable state file: ${errorText(err)}`);
  }
  // Unknown never means first run: an established install must not see it.
  return "complete";
}

/**
 * Read the state, or decide and persist it on the first boot that has no file.
 * `facts` is only consulted then, before anything else this boot writes.
 *
 * Never throws: the marker is optional, and boot must not fail over it. When
 * the decision cannot be read or persisted, this boot treats the install as
 * `complete` in memory (no welcome, no naming) and a later boot decides again.
 */
export function initOnboarding(facts: () => InstallFacts): OnboardingState {
  try {
    if (existsSync(ONBOARDING_PATH)) {
      state = readState();
    } else {
      const decided = initialOnboardingState(facts());
      writeState(decided);
      state = decided;
    }
  } catch (err) {
    console.warn(
      `[onboarding] could not record first-run state, treating this install as set up: ${errorText(err)}`,
    );
    state = "complete";
  }
  return state;
}

/**
 * A turn refused because it would run in the guided setup conversation after
 * setup finished (`docs/onboarding.md`). That session's prompt was frozen with
 * the setup section and finish tool, and frozen prompts never change, so the
 * session stays readable but runs nothing more.
 */
export class SetupFinishedError extends Error {
  constructor() {
    super("Setup is finished. Continue in your Personal Assistant.");
    this.name = "SetupFinishedError";
  }
}

/**
 * Refuse a turn in a session that ran guided setup once setup is over.
 * `guidedSetup` is that session's frozen prompt condition; while setup lasts
 * it may still run.
 */
export function assertSetupSessionOpen(guidedSetup: () => boolean): void {
  if (onboardingState() === "setup") return;
  if (guidedSetup()) throw new SetupFinishedError();
}

/** The install's state; `complete` until boot has decided. */
export function onboardingState(): OnboardingState {
  return state ?? "complete";
}

/** Who hears of the change; `hub.ts` sets it. */
export function setOnboardingBroadcaster(
  value: (message: ServerMessage) => void,
): void {
  broadcast = value;
}

/**
 * Save "Larry" as the Personal Assistant's name when none is saved (absent,
 * blank or the default), as a conditional leaf write that runs the normal
 * settings effects.
 *
 * Check and write are one synchronous step, which is what keeps a value
 * another writer saved from being replaced: the only `await` comes BEFORE
 * the stored name is read, and `saveSettings` persists an app section before
 * its own first `await` (pinned in `settingsService.test.ts`). So nothing
 * else in this process can write settings between the read, the patch built
 * from the current section, and the write; the server is the file's only
 * writer.
 */
async function nameAssistantIfUnsaved(): Promise<boolean> {
  const { saveSettings, settingsPatchForWrites } =
    await import("./settingsService.ts");
  // Synchronous from here until the write has landed.
  const saved = readStoredAppSettings().permanentAssistant?.name?.trim();
  if (saved && saved !== DEFAULT_PERMANENT_ASSISTANT_NAME) return false;
  const written = saveSettings(
    settingsPatchForWrites([
      { path: "permanentAssistant.name", value: FIRST_RUN_ASSISTANT_NAME },
    ]),
  );
  // What is awaited is the write's outcome and its effects.
  try {
    await written;
  } catch (err) {
    // The name was saved but an effect after it failed: the naming itself is
    // done and is neither redone nor undone. A write that did not land throws.
    const now = readStoredAppSettings().permanentAssistant?.name?.trim();
    if (now !== FIRST_RUN_ASSISTANT_NAME) throw err;
    console.warn(
      `[onboarding] named the assistant, but its follow-up failed: ${errorText(err)}`,
    );
  }
  return true;
}

/**
 * Memory as a first run starts it: nothing loaded, nothing learned, no
 * maintenance pass. It is also what `memory/memoryGate.ts` enforces while
 * onboarding is `pending`, whatever is stored.
 */
export const FIRST_RUN_MEMORY = {
  loadingEnabled: false,
  learningMode: "off",
  maintenanceEnabled: false,
} as const;

type FirstRunMemoryKey = keyof typeof FIRST_RUN_MEMORY;
const FIRST_RUN_MEMORY_KEYS = Object.keys(
  FIRST_RUN_MEMORY,
) as FirstRunMemoryKey[];

/**
 * Turn memory off on a fresh install: leaf writes of
 * {@link FIRST_RUN_MEMORY}'s settings that run the normal settings effects.
 * The defaults leave memory on, which suits an established install but would
 * have a brand-new user's turns feed the paid memory processor before they
 * agreed to it.
 *
 * Writes only the fields the settings file does not hold: a saved memory
 * setting is the user's choice and stands, and once this has written, a retry
 * is a no-op. Check and write are one synchronous step, as in
 * {@link nameAssistantIfUnsaved}. Throws when the write did not land.
 */
async function turnMemoryOffIfUnchosen(): Promise<void> {
  const { saveSettings, settingsPatchForWrites } =
    await import("./settingsService.ts");
  // Synchronous from here until the write has landed.
  const stored = () => readStoredAppSettings().memory;
  const unchosen = FIRST_RUN_MEMORY_KEYS.filter(
    (key) => stored()?.[key] === undefined,
  );
  if (unchosen.length === 0) return;
  const written = saveSettings(
    settingsPatchForWrites(
      unchosen.map((key) => ({
        path: `memory.${key}`,
        value: FIRST_RUN_MEMORY[key],
      })),
    ),
  );
  try {
    await written;
  } catch (err) {
    // As with the name: a write that landed counts as done.
    const now = stored();
    if (unchosen.some((key) => now?.[key] !== FIRST_RUN_MEMORY[key])) throw err;
    console.warn(
      `[onboarding] turned memory off, but its follow-up failed: ${errorText(err)}`,
    );
  }
}

let optingOut: Promise<void> | undefined;

/** {@link turnMemoryOffIfUnchosen}, one run at a time; callers share it. */
function optOutOfMemory(): Promise<void> {
  optingOut ??= turnMemoryOffIfUnchosen().finally(() => {
    optingOut = undefined;
  });
  return optingOut;
}

/**
 * Persist a fresh install's memory opt-out. Boot calls it right after
 * {@link initOnboarding}; every {@link checkOnboarding} retries it while the
 * install is `pending`, and setup does not begin until it has landed. Until
 * then the gate keeps memory off. Never throws: a failure must not fail boot.
 */
export async function persistFirstRunMemoryOptOut(): Promise<void> {
  if (state !== "pending") return;
  try {
    await optOutOfMemory();
  } catch (err) {
    console.warn(
      `[onboarding] could not turn memory off yet, will retry: ${errorText(err)}`,
    );
  }
}

/** An account that can run something now, with the models it offers. */
export interface UsableAccount {
  id: string;
  provider: CredentialProfileProvider;
  models: readonly ModelOption[];
}

/** The Personal Assistant's model slot, as first run pins it. */
export interface AssistantPin {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  credentialProfileId: string;
}

/**
 * What first run reads from the accounts. Injectable so the transitions can be
 * tested without signing in to a provider.
 */
export interface OnboardingProbe {
  /** The first account that is enabled, signed in and offers a model. */
  usableAccount(): Promise<UsableAccount | undefined>;
  /** Whether some enabled, signed-in account can run this model. */
  slotRunnable(slot: { provider: string; modelId: string }): Promise<boolean>;
}

const liveProbe: OnboardingProbe = {
  async usableAccount() {
    const { listCredentialProfiles } = await import("./credentialProfiles.ts");
    const { modelsForAccount } = await import("./harnesses/models.ts");
    for (const profile of listCredentialProfiles()) {
      if (!profile.enabled || profile.status !== "ready") continue;
      const models = await modelsForAccount(profile).catch(() => []);
      if (models.length > 0)
        return { id: profile.id, provider: profile.provider, models };
    }
    return undefined;
  },
  async slotRunnable(slot) {
    const { listCredentialProfiles } = await import("./credentialProfiles.ts");
    const { accountOffersModel } = await import("./harnesses/models.ts");
    for (const profile of listCredentialProfiles()) {
      if (!profile.enabled || profile.status !== "ready") continue;
      if (!accountServesModel(profile, slot.provider)) continue;
      const offered = await accountOffersModel(
        profile.id,
        slot.provider,
        slot.modelId,
      ).catch(() => false);
      if (offered) return true;
    }
    return false;
  },
};

/**
 * The model the Personal Assistant runs on `account` when first run pins it:
 * Claude's `opus` alias at medium thinking; on OpenAI the default helper model
 * when offered, else the first Codex model; on an OpenAI-compatible endpoint
 * its first model. Thinking for the latter two starts at high, clamped to what
 * the model supports.
 */
export function assistantPinFor(
  account: UsableAccount,
): AssistantPin | undefined {
  const { models } = account;
  const model =
    account.provider === "claude"
      ? (models.find(
          (m) => m.provider === CLAUDE_SDK_PROVIDER && m.id === "opus",
        ) ?? models[0])
      : account.provider === "openai-codex"
        ? (models.find(
            (m) =>
              m.provider === DEFAULT_HELPER_MODEL.provider &&
              m.id === DEFAULT_HELPER_MODEL.modelId,
          ) ??
          models.find((m) => m.provider === "openai-codex") ??
          models[0])
        : models[0];
  if (!model) return undefined;
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: clampThinkingLevelForModel(
      model,
      account.provider === "claude" ? "medium" : "high",
    ),
    credentialProfileId: account.id,
  };
}

/** The assistant's model slot as the settings FILE holds it (no defaults). */
function storedAssistantSlot(): {
  provider: string | undefined;
  modelId: string | undefined;
  thinkingLevel: string | undefined;
  credentialProfileId: string | undefined;
} {
  const stored = readStoredAppSettings().permanentAssistant;
  return {
    provider: stored?.provider,
    modelId: stored?.modelId,
    thinkingLevel: stored?.thinkingLevel,
    credentialProfileId: stored?.credentialProfileId,
  };
}

function sameSlot(
  a: ReturnType<typeof storedAssistantSlot>,
  b: ReturnType<typeof storedAssistantSlot>,
): boolean {
  return (
    a.provider === b.provider &&
    a.modelId === b.modelId &&
    a.thinkingLevel === b.thinkingLevel &&
    a.credentialProfileId === b.credentialProfileId
  );
}

/**
 * Run the Personal Assistant on `account` when its saved model slot cannot
 * run anywhere (or none is saved), as leaf writes of the slot's four fields
 * that run the normal settings effects.
 *
 * A slot that can run is never touched. The runnability check is async, so the
 * slot it judged is compared with the file again in the synchronous step that
 * writes (see {@link nameAssistantIfUnsaved}): a model another writer saved
 * meanwhile is the user's choice and stands.
 */
async function pinAssistantIfUnrunnable(
  account: UsableAccount,
  probe: OnboardingProbe,
): Promise<void> {
  const before = storedAssistantSlot();
  if (
    before.provider &&
    before.modelId &&
    (await probe.slotRunnable({
      provider: before.provider,
      modelId: before.modelId,
    }))
  )
    return;
  const pin = assistantPinFor(account);
  if (!pin) return;
  const { saveSettings, settingsPatchForWrites } =
    await import("./settingsService.ts");
  // Synchronous from here until the write has landed.
  if (!sameSlot(before, storedAssistantSlot())) return;
  const written = saveSettings(
    settingsPatchForWrites([
      { path: "permanentAssistant.provider", value: pin.provider },
      { path: "permanentAssistant.modelId", value: pin.modelId },
      { path: "permanentAssistant.thinkingLevel", value: pin.thinkingLevel },
      {
        path: "permanentAssistant.credentialProfileId",
        value: pin.credentialProfileId,
      },
    ]),
  );
  try {
    await written;
  } catch (err) {
    // As with the name: a slot that landed counts as pinned.
    if (!sameSlot(storedAssistantSlot(), pin)) throw err;
    console.warn(
      `[onboarding] pinned the assistant's model, but its follow-up failed: ${errorText(err)}`,
    );
  }
}

/**
 * Leave the pending state for guided setup, in an order where any failure
 * leaves it `pending` and the next check retries: run the assistant on the
 * account when its slot cannot run (a no-op once it can), name it (a no-op
 * once named), retire a Personal Assistant conversation started before setup
 * so the next one carries the setup prompt, persist `setup`, then take it in
 * memory and tell the browsers, once.
 *
 * The pin goes first: a leaf write carries the whole current section, so the
 * name write would otherwise store the default slot as if the user chose it.
 */
async function beginSetup(
  account: UsableAccount,
  probe: OnboardingProbe,
): Promise<void> {
  if (state !== "pending") return;
  await pinAssistantIfUnrunnable(account, probe);
  await nameAssistantIfUnsaved();
  const { permanentAssistantStore } =
    await import("./db/permanentAssistantStore.ts");
  if (permanentAssistantStore.sessionId()) {
    const { rotatePermanentAssistantSession } =
      await import("./permanentAssistant.ts");
    await rotatePermanentAssistantSession();
  }
  // Synchronous from here: a Personal Assistant acquisition started after the
  // rotation cannot create its session before `setup` is taken.
  writeState("setup");
  state = "setup";
  broadcast?.({ type: "onboarding", state });
}

let checking: Promise<void> | undefined;
let checkAgain = false;

/**
 * Begin guided setup when a usable account exists. Called wherever the server
 * learns accounts may have changed; free once past `pending`. Each check first
 * persists the memory opt-out, so a failure there leaves `pending` for the next
 * check. Checks never overlap: one asked for while another runs runs once
 * after it.
 */
export function checkOnboarding(
  probe: Partial<OnboardingProbe> = {},
): Promise<void> {
  if (state !== "pending") return Promise.resolve();
  if (checking) {
    checkAgain = true;
    return checking;
  }
  const effective: OnboardingProbe = { ...liveProbe, ...probe };
  checking = (async () => {
    try {
      do {
        checkAgain = false;
        if (state !== "pending") break;
        // Before anything else, setup included: its pin and name writes may
        // rotate the assistant, which flushes memory observations.
        await optOutOfMemory();
        const account = await effective.usableAccount();
        if (account) await beginSetup(account, effective);
      } while (checkAgain && state === "pending");
    } catch (err) {
      console.warn(`[onboarding] check failed: ${errorText(err)}`);
    } finally {
      checking = undefined;
    }
  })();
  return checking;
}

let finishing: Promise<OnboardingState> | undefined;

/**
 * End guided setup: the user pressed Finish setup, or told the assistant they
 * are done. Rotates the Personal Assistant first, so the normal conversation
 * never carries the setup prompt (the setup conversation stays on disk), then
 * persists `complete`, takes it in memory and tells the browsers, once. A
 * failure leaves `setup` and throws; finishing again retries. Outside `setup`
 * it changes nothing and answers the current state.
 */
export function finishOnboarding(): Promise<OnboardingState> {
  if (state !== "setup") return Promise.resolve(onboardingState());
  finishing ??= (async () => {
    try {
      const { rotatePermanentAssistantSession } =
        await import("./permanentAssistant.ts");
      await rotatePermanentAssistantSession();
      if (state !== "setup") return onboardingState();
      writeState("complete");
      state = "complete";
      broadcast?.({ type: "onboarding", state });
      return state;
    } finally {
      finishing = undefined;
    }
  })();
  return finishing;
}
