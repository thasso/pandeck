import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedLegacyDefaultAccounts } from "../test/legacyDefaultAccounts.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-models-refresh-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
// An install that still has Default OpenAI: its runtime is the display one.
await seedLegacyDefaultAccounts();

/** Every `refresh` the runtimes saw, by auth path, with the options it carried. */
const refreshCalls: Array<{ authPath: string; force: boolean }> = [];
/**
 * Catalog failures as pi really reports them: `refresh()` RESOLVES with a
 * per-provider error map and never throws them. Keyed by auth path, then by
 * provider id.
 */
const resolvedErrorsByAuthPath = new Map<string, Map<string, Error>>();
/** A runtime that cannot refresh at all — the only case that rejects. */
const throwingAuthPaths = new Map<string, string>();
/** What every registry offers; a refresh may replace it. */
let availableModels: Array<Record<string, unknown>> = [];
/** Run inside each `refresh`, as a catalog arriving would change the registry. */
let onRefresh: (() => void) | undefined;

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeModelRuntime {
    readonly authPath: string;

    constructor(options: { authPath: string }) {
      this.authPath = options.authPath;
    }

    static async create(options: { authPath: string }) {
      return new FakeModelRuntime(options);
    }

    // The server's credential guard wraps it (`serverCredentialPairing.ts`).
    async getAuth() {
      return undefined;
    }

    async refresh(options?: { force?: boolean }) {
      refreshCalls.push({
        authPath: this.authPath,
        force: options?.force === true,
      });
      const rejection = throwingAuthPaths.get(this.authPath);
      if (rejection) throw new Error(rejection);
      onRefresh?.();
      return {
        aborted: false,
        errors:
          resolvedErrorsByAuthPath.get(this.authPath) ??
          new Map<string, Error>(),
      };
    }
    getError() {
      return undefined;
    }
    async login() {}
  }

  class FakeModelRegistry {
    getAvailable() {
      return availableModels;
    }
    getAll() {
      return availableModels;
    }
    registerProvider() {}
    unregisterProvider() {}
  }

  return { ModelRegistry: FakeModelRegistry, ModelRuntime: FakeModelRuntime };
});

const { createCredentialProfile, piAgentDir } =
  await import("../credentialProfiles.ts");
const secondary = createCredentialProfile({
  name: "Secondary",
  provider: "openai-codex",
});
const broken = createCredentialProfile({
  name: "Broken",
  provider: "openai-codex",
});
const defaultAuth = join(piAgentDir("default"), "auth.json");
const secondaryAuth = join(piAgentDir(secondary.id), "auth.json");
const brokenAuth = join(piAgentDir(broken.id), "auth.json");

const {
  refreshModelCatalogsInBackground,
  refreshModels,
  startModelCatalogRefresh,
  subscribePickerModelsChanged,
} = await import("./models.ts");

test("the explicit refresh forces a fetch on every OpenAI account's runtime", async () => {
  refreshCalls.length = 0;

  const { error } = await refreshModels();

  assert.equal(error, undefined);
  // Without `force` pi keeps a four-hour freshness window and a second click
  // inside it never reaches the network — the bug this guards.
  assert.deepEqual(
    [...refreshCalls].sort((a, b) => a.authPath.localeCompare(b.authPath)),
    [defaultAuth, secondaryAuth, brokenAuth]
      .sort((a, b) => a.localeCompare(b))
      .map((authPath) => ({ authPath, force: true })),
  );
});

test("a catalog failure pi RESOLVES with is reported, not swallowed", async () => {
  refreshCalls.length = 0;
  // This is how pi really reports an unreachable catalog: the promise fulfils
  // and the failure is an entry in `errors`. A refresh that only watched for a
  // rejection would call this a clean update.
  resolvedErrorsByAuthPath.set(
    brokenAuth,
    new Map([["openai-codex", new Error("catalog unreachable")]]),
  );
  resolvedErrorsByAuthPath.set(
    defaultAuth,
    new Map([["openai-compatible", new Error("502 from catalog")]]),
  );

  const { error } = await refreshModels();

  // The other runtimes still refreshed, and the button still gets its answer.
  assert.equal(refreshCalls.length, 3);
  assert.equal(
    error,
    "openai-compatible: 502 from catalog; Broken / openai-codex: catalog unreachable",
  );

  resolvedErrorsByAuthPath.clear();
});

test("a runtime that cannot refresh at all is named too", async () => {
  refreshCalls.length = 0;
  throwingAuthPaths.set(secondaryAuth, "agent directory unreadable");

  const { error } = await refreshModels();

  assert.equal(refreshCalls.length, 3);
  assert.equal(error, "Secondary: agent directory unreadable");

  throwingAuthPaths.delete(secondaryAuth);
});

function codexModel(id: string) {
  return {
    provider: "openai-codex",
    id,
    name: id,
    reasoning: false,
    contextWindow: 200_000,
  };
}

test("the background refresh leaves every runtime's catalog to pi's freshness window", async () => {
  refreshCalls.length = 0;

  await refreshModelCatalogsInBackground();

  assert.deepEqual(
    [...refreshCalls].sort((a, b) => a.authPath.localeCompare(b.authPath)),
    [defaultAuth, secondaryAuth, brokenAuth]
      .sort((a, b) => a.localeCompare(b))
      .map((authPath) => ({ authPath, force: false })),
  );
});

test("the background refresh logs failures and never rejects", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  throwingAuthPaths.set(secondaryAuth, "agent directory unreadable");
  resolvedErrorsByAuthPath.set(
    brokenAuth,
    new Map([["openai-codex", new Error("catalog unreachable")]]),
  );
  try {
    await refreshModelCatalogsInBackground();
    assert.deepEqual(warn.mock.calls, [
      [
        "[models] background catalog refresh:",
        "Secondary: agent directory unreadable; Broken / openai-codex: catalog unreachable",
      ],
    ]);
  } finally {
    throwingAuthPaths.delete(secondaryAuth);
    resolvedErrorsByAuthPath.clear();
    warn.mockRestore();
  }
});

test("subscribers hear a background refresh only when the picker models changed", async () => {
  let heard = 0;
  const unsubscribe = subscribePickerModelsChanged(() => heard++);
  try {
    availableModels = [codexModel("gpt-5.5")];
    await refreshModelCatalogsInBackground();
    assert.equal(heard, 0, "an unchanged catalog is not announced");

    onRefresh = () => {
      availableModels = [codexModel("gpt-5.5"), codexModel("gpt-6")];
    };
    await refreshModelCatalogsInBackground();
    assert.equal(heard, 1, "a model the catalog brought in is announced");

    await refreshModelCatalogsInBackground();
    assert.equal(heard, 1, "and only once");
  } finally {
    onRefresh = undefined;
    availableModels = [];
    unsubscribe();
  }
});

test("a background refresh already running is joined, not repeated", async () => {
  refreshCalls.length = 0;
  await Promise.all([
    refreshModelCatalogsInBackground(),
    refreshModelCatalogsInBackground(),
  ]);
  assert.equal(refreshCalls.length, 3);
});

test("the periodic refresh runs once at start, then hourly, never forced", async () => {
  vi.useFakeTimers();
  try {
    refreshCalls.length = 0;
    startModelCatalogRefresh();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(refreshCalls.length, 3, "a fresh server checks at once");

    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    assert.equal(refreshCalls.length, 3);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(refreshCalls.length, 6, "and again an hour later");
    assert.ok(refreshCalls.every((call) => !call.force));
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
