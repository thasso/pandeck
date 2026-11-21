/**
 * First-run onboarding state (`docs/onboarding.md`): the server, not a
 * browser's view of the accounts, decides whether this install is on its
 * first run.
 *
 * `onboarding.json` under `DATA_DIR` holds `pending` or `complete`. Without the
 * file, boot decides once: an install is fresh only when it has no app settings
 * file, no session rows and no credential profiles, and is not a gateway client
 * (whose accounts arrive from a remote gateway after boot). Everything else is
 * `complete`, so an established install never sees first run. `complete` is
 * final.
 *
 * While `pending`, the server finishes onboarding itself the moment it sees a
 * usable account (enabled, signed in, offering a model), and in the same step
 * names the Personal Assistant "Larry" when no name is saved.
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
  DEFAULT_PERMANENT_ASSISTANT_NAME,
  FIRST_RUN_ASSISTANT_NAME,
  type OnboardingState,
  type ServerMessage,
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
    if (parsed?.state === "pending" || parsed?.state === "complete")
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

/** Whether an account can run anything: enabled, signed in, offering a model. */
async function anyUsableAccount(): Promise<boolean> {
  const { listCredentialProfiles } = await import("./credentialProfiles.ts");
  const { modelsForAccount } = await import("./harnesses/models.ts");
  for (const profile of listCredentialProfiles()) {
    if (!profile.enabled || profile.status !== "ready") continue;
    const models = await modelsForAccount(profile).catch(() => []);
    if (models.length > 0) return true;
  }
  return false;
}

/**
 * Finish first run, in an order where any failure leaves it `pending` and the
 * next check retries: name the assistant (a no-op once named), persist
 * `complete`, then take it in memory and tell the browsers, once.
 */
async function complete(): Promise<void> {
  if (state !== "pending") return;
  await nameAssistantIfUnsaved();
  writeState("complete");
  state = "complete";
  broadcast?.({ type: "onboarding", state });
}

let checking: Promise<void> | undefined;
let checkAgain = false;

/**
 * Finish onboarding when a usable account exists. Called wherever the server
 * learns accounts may have changed; free once `complete`. Checks never overlap:
 * one asked for while another runs runs once after it.
 */
export function checkOnboarding(
  usable: () => Promise<boolean> = anyUsableAccount,
): Promise<void> {
  if (state !== "pending") return Promise.resolve();
  if (checking) {
    checkAgain = true;
    return checking;
  }
  checking = (async () => {
    try {
      do {
        checkAgain = false;
        if (state === "pending" && (await usable())) await complete();
      } while (checkAgain && state === "pending");
    } catch (err) {
      console.warn(`[onboarding] check failed: ${errorText(err)}`);
    } finally {
      checking = undefined;
    }
  })();
  return checking;
}
