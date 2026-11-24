import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  disableClaudeSdkForTests,
  enableClaudeSdkForTests,
} from "./test/claudeSdkEnabled.ts";

// Recorded, not replaced: a refused fallback must leave no health or retry.
vi.mock("./accountHealth.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./accountHealth.ts")>();
  return {
    ...original,
    observeAccountHealth: vi.fn(original.observeAccountHealth),
    reportAccountRunFailure: vi.fn(original.reportAccountRunFailure),
    reportAccountRunWorking: vi.fn(original.reportAccountRunWorking),
  };
});
vi.mock("./accountRouter.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./accountRouter.ts")>();
  return { ...original, pickAccount: vi.fn(original.pickAccount) };
});
const health = await import("./accountHealth.ts");
const router = await import("./accountRouter.ts");
import { buildTestPdf } from "./test/pdfFixtures.ts";
import {
  convertPdfToMarkdown,
  setPdfClaudeFallback,
} from "./documentConversion.ts";
import { registerPdfClaudeFallback } from "./pdfClaudeFallback.ts";
import { setClaudeSdkOneShotSeam } from "./claudeSdk/oneShot.ts";
import {
  buildRealClaudeSdkSeam,
  type ClaudeQueryParams,
  type ClaudeSdkMessage,
  type ClaudeSdkSeam,
} from "./claudeSdk/sdkSeam.ts";
import { updateSettings } from "./settings.ts";
import { CREDENTIAL_PROFILES_ROOT } from "./credentialProfilePaths.ts";
import { listCredentialProfiles } from "./credentialProfiles.ts";
import { seedLegacyDefaultAccounts } from "./test/legacyDefaultAccounts.ts";

const CLAUDE_DEFAULTS = {
  provider: "claude-sdk",
  modelId: "sonnet",
  thinkingLevel: "off" as const,
  timeoutMs: 180_000,
};

function fakeSeam(
  text: string,
  state: { called: boolean; params?: ClaudeQueryParams },
  resultSubtype = "success",
): ClaudeSdkSeam {
  return {
    query(params: ClaudeQueryParams) {
      state.called = true;
      state.params = params;
      const messages: ClaudeSdkMessage[] = [
        {
          type: "assistant",
          uuid: "a1",
          session_id: "s1",
          message: {
            id: "m1",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        } as unknown as ClaudeSdkMessage,
        {
          type: "result",
          subtype: resultSubtype,
          session_id: "s1",
          usage: { input_tokens: 10, output_tokens: 5 },
          total_cost_usd: 0.001,
        } as unknown as ClaudeSdkMessage,
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
        },
      };
    },
  };
}

// Runs on an install that still has its protected default accounts.
await seedLegacyDefaultAccounts();

// These suites drive Claude runs; the integration is off by default.
beforeEach(enableClaudeSdkForTests);

describe("registerPdfClaudeFallback", () => {
  afterEach(() => {
    setPdfClaudeFallback(null);
    setClaudeSdkOneShotSeam(buildRealClaudeSdkSeam);
  });

  test("transcribes a scanned PDF through the Claude document-block one-shot", async () => {
    updateSettings({
      pdfConversion: { fallbackEnabled: true, ...CLAUDE_DEFAULTS },
    });
    const state: { called: boolean; params?: ClaudeQueryParams } = {
      called: false,
    };
    setClaudeSdkOneShotSeam(() =>
      Promise.resolve(fakeSeam("# Scanned transcription", state)),
    );
    registerPdfClaudeFallback();

    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 2 }),
    });
    assert.equal(state.called, true, "the Claude one-shot ran");
    assert.equal(result.engine, "claude");
    assert.equal(result.usedClaudeFallback, true);
    assert.match(result.markdown, /Scanned transcription/);

    // The PDF bytes rode along as a base64 document block.
    const streamed: Array<Record<string, any>> = [];
    for await (const m of state.params!.prompt as AsyncIterable<
      Record<string, any>
    >)
      streamed.push(m);
    const doc = streamed[0]!.message.content[0];
    assert.equal(doc.type, "document");
    assert.equal(doc.source.media_type, "application/pdf");
  });

  test("rejects a transcript cut short by an error result", async () => {
    updateSettings({
      pdfConversion: { fallbackEnabled: true, ...CLAUDE_DEFAULTS },
    });
    const state = { called: false };
    setClaudeSdkOneShotSeam(() =>
      Promise.resolve(fakeSeam("# Partial", state, "error_max_turns")),
    );
    registerPdfClaudeFallback();

    await assert.rejects(
      () => convertPdfToMarkdown({ bytes: buildTestPdf({ pages: 2 }) }),
      /error_max_turns/,
    );
    assert.equal(state.called, true);
  });

  test("declines (no Claude call) when the fallback is disabled in settings", async () => {
    updateSettings({
      pdfConversion: { fallbackEnabled: false, ...CLAUDE_DEFAULTS },
    });
    const state = { called: false };
    setClaudeSdkOneShotSeam(() =>
      Promise.resolve(fakeSeam("should not run", state)),
    );
    registerPdfClaudeFallback();

    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 2 }),
    });
    assert.equal(state.called, false, "Claude is never called when disabled");
    assert.equal(result.engine, "pdf2md");
    assert.equal(result.usedClaudeFallback, false);
    assert.equal(result.lowText, true);
    assert.match(result.note ?? "", /disabled/i);
  });

  test("degrades with an actionable note, and no Claude call, health or retry, while the Claude SDK is off", async () => {
    updateSettings({
      pdfConversion: { fallbackEnabled: true, ...CLAUDE_DEFAULTS },
    });
    await disableClaudeSdkForTests();
    const state = { called: false };
    setClaudeSdkOneShotSeam(() =>
      Promise.resolve(fakeSeam("should not run", state)),
    );
    registerPdfClaudeFallback();
    vi.mocked(health.observeAccountHealth).mockClear();
    vi.mocked(health.reportAccountRunFailure).mockClear();
    vi.mocked(health.reportAccountRunWorking).mockClear();
    vi.mocked(router.pickAccount).mockClear();

    const result = await convertPdfToMarkdown({
      bytes: buildTestPdf({ pages: 2 }),
    });
    assert.equal(state.called, false, "Claude is never called");
    assert.equal(result.engine, "pdf2md");
    assert.equal(result.usedClaudeFallback, false);
    assert.equal(result.lowText, true);
    assert.equal(
      result.note,
      'PDF text layer looks empty (likely scanned); the Claude fallback could not run. Claude SDK is disabled in settings. Turn on "Enable Claude SDK sessions" in Settings > Claude SDK to run Claude models.',
    );
    assert.equal(vi.mocked(health.observeAccountHealth).mock.calls.length, 0);
    assert.equal(
      vi.mocked(health.reportAccountRunFailure).mock.calls.length,
      0,
    );
    assert.equal(
      vi.mocked(health.reportAccountRunWorking).mock.calls.length,
      0,
    );
    // No second account was tried.
    assert.ok(
      vi
        .mocked(router.pickAccount)
        .mock.calls.every(([request]) => !request.excludeProfileIds?.length),
    );
  });

  for (const sdkEnabled of [false, true]) {
    test(`degrades without a Claude account when the SDK is ${sdkEnabled ? "enabled" : "disabled"}`, async () => {
      updateSettings({
        pdfConversion: { fallbackEnabled: true, ...CLAUDE_DEFAULTS },
      });
      if (sdkEnabled) await enableClaudeSdkForTests();
      else await disableClaudeSdkForTests();

      const registry = join(CREDENTIAL_PROFILES_ROOT, "profiles.json");
      const originalRegistry = existsSync(registry)
        ? readFileSync(registry, "utf8")
        : undefined;
      const profiles = originalRegistry
        ? (JSON.parse(originalRegistry) as Array<{
            id: string;
            provider: string;
          }>)
        : [];
      writeFileSync(
        registry,
        `${JSON.stringify(
          profiles.filter((profile) => profile.provider !== "claude"),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      try {
        assert.equal(
          listCredentialProfiles().some(
            (profile) => profile.provider === "claude",
          ),
          false,
          "fixture has no current Claude accounts or protected legacy default",
        );
        assert.equal(
          profiles.some((profile) => profile.id === "claude-default"),
          true,
          "fixture starts with the protected legacy default that it removes",
        );

        const state = { called: false };
        setClaudeSdkOneShotSeam(() =>
          Promise.resolve(fakeSeam("should not run", state)),
        );
        registerPdfClaudeFallback();
        vi.mocked(health.observeAccountHealth).mockClear();
        vi.mocked(health.reportAccountRunFailure).mockClear();
        vi.mocked(health.reportAccountRunWorking).mockClear();
        vi.mocked(router.pickAccount).mockClear();

        const result = await convertPdfToMarkdown({
          bytes: buildTestPdf({ pages: 2 }),
        });
        assert.equal(state.called, false, "Claude is never called");
        assert.equal(result.engine, "pdf2md");
        assert.equal(result.usedClaudeFallback, false);
        assert.equal(result.lowText, true);
        assert.equal(
          result.note,
          sdkEnabled
            ? "PDF text layer looks empty (likely scanned); the Claude fallback could not run. No Claude account is configured. Add or sign in to a Claude account in Settings > Accounts, then retry."
            : 'PDF text layer looks empty (likely scanned); the Claude fallback could not run. Claude SDK is disabled in settings. Turn on "Enable Claude SDK sessions" in Settings > Claude SDK to run Claude models.',
        );
        assert.equal(vi.mocked(router.pickAccount).mock.calls.length, 0);
        assert.equal(
          vi.mocked(health.observeAccountHealth).mock.calls.length,
          0,
        );
        assert.equal(
          vi.mocked(health.reportAccountRunFailure).mock.calls.length,
          0,
        );
        assert.equal(
          vi.mocked(health.reportAccountRunWorking).mock.calls.length,
          0,
        );
      } finally {
        if (originalRegistry === undefined) writeFileSync(registry, "[]\n");
        else writeFileSync(registry, originalRegistry, { mode: 0o600 });
      }
    });
  }
});
