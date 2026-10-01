import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-models-refresh-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

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

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeModelRuntime {
    readonly authPath: string;

    constructor(options: { authPath: string }) {
      this.authPath = options.authPath;
    }

    static async create(options: { authPath: string }) {
      return new FakeModelRuntime(options);
    }

    async refresh(options?: { force?: boolean }) {
      refreshCalls.push({
        authPath: this.authPath,
        force: options?.force === true,
      });
      const rejection = throwingAuthPaths.get(this.authPath);
      if (rejection) throw new Error(rejection);
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
      return [];
    }
    getAll() {
      return [];
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

const { refreshModels } = await import("./models.ts");

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

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
