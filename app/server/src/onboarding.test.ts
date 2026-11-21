import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "onboarding-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
const {
  checkOnboarding,
  initOnboarding,
  initialOnboardingState,
  onboardingState,
  setOnboardingBroadcaster,
} = await import("./onboarding.ts");
const { APP_SETTINGS_PATH, readStoredAppSettings } =
  await import("./appSettingsFile.ts");
const { getSettings } = await import("./settings.ts");
const { saveSettings } = await import("./settingsService.ts");
// The hub installs its own broadcaster when it loads (a settings write's
// effects can load it); load it first so the test's listener is the last one.
await import("./hub.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const STATE_PATH = join(tmp, "data", "onboarding.json");
const FRESH = {
  settingsFile: false,
  sessions: false,
  accounts: false,
  gatewayClient: false,
};
const broadcasts: ServerMessage[] = [];
setOnboardingBroadcaster((message) => broadcasts.push(message));

/** A directory where a write's temp file goes makes that write fail (EISDIR). */
const STATE_TMP = `${STATE_PATH}.tmp`;
const SETTINGS_TMP = `${APP_SETTINGS_PATH}.tmp`;
const block = (path: string) => mkdirSync(path, { recursive: true });

beforeEach(() => {
  for (const path of [STATE_PATH, APP_SETTINGS_PATH, STATE_TMP, SETTINGS_TMP])
    rmSync(path, { recursive: true, force: true });
  broadcasts.length = 0;
});

describe("fresh-install detection", () => {
  test("only an install with nothing at all is fresh", () => {
    assert.equal(initialOnboardingState(FRESH), "pending");
    for (const used of [
      "settingsFile",
      "sessions",
      "accounts",
      "gatewayClient",
    ] as const)
      assert.equal(
        initialOnboardingState({ ...FRESH, [used]: true }),
        "complete",
        used,
      );
  });

  test("the first boot persists its decision privately", () => {
    assert.equal(
      initOnboarding(() => FRESH),
      "pending",
    );
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(statSync(STATE_PATH).mode & 0o777, 0o600);
  });

  test("an established install is complete and never consults the facts again", () => {
    assert.equal(
      initOnboarding(() => ({ ...FRESH, accounts: true })),
      "complete",
    );
    // Later boots read the file: an emptied install does not go back.
    let consulted = false;
    assert.equal(
      initOnboarding(() => {
        consulted = true;
        return FRESH;
      }),
      "complete",
    );
    assert.equal(consulted, false);
  });

  test("an unreadable state file never means first run", () => {
    writeFileSync(STATE_PATH, "{not json");
    assert.equal(
      initOnboarding(() => FRESH),
      "complete",
    );
  });
});

describe("finishing first run", () => {
  test("waits for a usable account, then completes once and for good", async () => {
    initOnboarding(() => FRESH);
    await checkOnboarding(async () => false);
    assert.equal(onboardingState(), "pending");
    assert.equal(broadcasts.length, 0);

    await checkOnboarding(async () => true);
    assert.equal(onboardingState(), "complete");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "complete" }]);
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "complete",
    });

    // Complete is final, whatever is asked or read later.
    await checkOnboarding(async () => true);
    assert.equal(broadcasts.length, 1);
    assert.equal(
      initOnboarding(() => FRESH),
      "complete",
    );
  });

  test("names an unsaved assistant Larry through the settings file", async () => {
    initOnboarding(() => FRESH);
    assert.equal(existsSync(APP_SETTINGS_PATH), false);
    assert.equal(getSettings().permanentAssistant.name, "Personal Assistant");
    await checkOnboarding(async () => true);
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");
  });

  test("never overwrites a saved name", async () => {
    initOnboarding(() => FRESH);
    await saveSettings({
      permanentAssistant: { ...getSettings().permanentAssistant, name: "Ada" },
    });
    await checkOnboarding(async () => true);
    assert.equal(getSettings().permanentAssistant.name, "Ada");
  });

  test("keeps every other assistant field another writer saved", async () => {
    initOnboarding(() => FRESH);
    // Saved while first run is pending, e.g. from Settings in another tab.
    await saveSettings({
      permanentAssistant: {
        ...getSettings().permanentAssistant,
        additionalInstructions: "Be brief.",
        thinkingLevel: "high",
      },
    });
    await checkOnboarding(async () => true);
    const assistant = getSettings().permanentAssistant;
    assert.equal(assistant.name, "Larry");
    assert.equal(assistant.additionalInstructions, "Be brief.");
    assert.equal(assistant.thinkingLevel, "high");
  });

  test("overlapping checks complete once", async () => {
    initOnboarding(() => FRESH);
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const first = checkOnboarding(async () => {
      await gate;
      return true;
    });
    const second = checkOnboarding(async () => true);
    release();
    await Promise.all([first, second]);
    assert.equal(onboardingState(), "complete");
    assert.equal(broadcasts.length, 1);
  });
});

describe("storage failures", () => {
  test("a marker that cannot be written never blocks boot and never enrolls", async () => {
    block(STATE_TMP);
    for (const facts of [{ ...FRESH, accounts: true }, FRESH]) {
      assert.equal(
        initOnboarding(() => facts),
        "complete",
      );
      assert.equal(onboardingState(), "complete");
      assert.equal(existsSync(STATE_PATH), false);
      await checkOnboarding(async () => true);
      assert.equal(existsSync(APP_SETTINGS_PATH), false);
      assert.equal(broadcasts.length, 0);
    }
  });

  test("a failed completion write stays pending and the next check finishes it", async () => {
    initOnboarding(() => FRESH);
    block(STATE_TMP);
    await checkOnboarding(async () => true);
    assert.equal(onboardingState(), "pending");
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(broadcasts.length, 0);
    // Named already; the retry does not name again, it only completes.
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");

    rmSync(STATE_TMP, { recursive: true });
    await checkOnboarding(async () => true);
    assert.equal(onboardingState(), "complete");
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "complete",
    });
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "complete" }]);
  });

  test("a failed naming write stays pending, and completes only once Larry is saved", async () => {
    initOnboarding(() => FRESH);
    block(SETTINGS_TMP);
    await checkOnboarding(async () => true);
    assert.equal(onboardingState(), "pending");
    assert.equal(readStoredAppSettings().permanentAssistant, undefined);
    assert.deepEqual(JSON.parse(readFileSync(STATE_PATH, "utf8")), {
      state: "pending",
    });
    assert.equal(broadcasts.length, 0);

    rmSync(SETTINGS_TMP, { recursive: true });
    await checkOnboarding(async () => true);
    assert.equal(readStoredAppSettings().permanentAssistant?.name, "Larry");
    assert.equal(onboardingState(), "complete");
    assert.deepEqual(broadcasts, [{ type: "onboarding", state: "complete" }]);
  });
});
