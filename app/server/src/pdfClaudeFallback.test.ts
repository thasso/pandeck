import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
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

const CLAUDE_DEFAULTS = {
  provider: "claude-sdk",
  modelId: "sonnet",
  thinkingLevel: "off" as const,
  timeoutMs: 180_000,
};

function fakeSeam(
  text: string,
  state: { called: boolean; params?: ClaudeQueryParams },
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
          subtype: "success",
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
});
