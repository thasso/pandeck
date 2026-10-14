import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { reportAccountRunFailure } from "../accountHealth.ts";
import { defaultClaudeProfileId } from "../credentialProfiles.ts";
import { setClaudeSdkOneShotSeam } from "../claudeSdk/oneShot.ts";
import type { ClaudeSdkMessage } from "../claudeSdk/sdkSeam.ts";
import { runOneShot, OneShotError } from "./oneShot.ts";

vi.mock("../accountHealth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../accountHealth.ts")>()),
  observeAccountHealth: vi.fn(() => ({ order: 1, generation: 0 })),
  reportAccountRunFailure: vi.fn(),
  reportAccountRunWorking: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

for (const source of [
  "wrapper",
  "structured",
  "synthetic-result",
  "wrapper-throw",
  "structured-throw",
] as const) {
  test.each([
    {
      status: 403,
      text: '{"error":{"type":"authentication_error","message":"Unauthorized"}}',
      kind: "auth",
      loginDeath: false,
    },
    {
      status: 403,
      text: '{"error":{"type":"permission_error","message":"OAuth token has been revoked"}}',
      kind: "auth",
      loginDeath: true,
    },
    {
      status: 503,
      text: '{"error":{"type":"authentication_error","message":"Unauthorized"}}',
      kind: "server",
      loginDeath: false,
    },
    {
      status: 401,
      text: "The request could not be processed",
      kind: "auth",
      loginDeath: true,
    },
  ])(
    `Claude one-shot ${source} preserves status $status: $text`,
    async (row) => {
      const profileId = defaultClaudeProfileId();
      setClaudeSdkOneShotSeam(async () => ({
        query() {
          return {
            async *[Symbol.asyncIterator]() {
              if (source === "synthetic-result")
                yield {
                  type: "assistant",
                  error: "permission_error",
                  message: {
                    model: "<synthetic>",
                    content: [{ type: "text", text: row.text }],
                  },
                } as unknown as ClaudeSdkMessage;
              yield {
                type: "result",
                subtype: "success",
                is_error: true,
                ...(!source.startsWith("wrapper")
                  ? { api_error_status: row.status }
                  : {}),
                result: source.startsWith("wrapper")
                  ? `API Error: ${row.status} ${row.text}`
                  : row.text,
                session_id: "status-one-shot",
              } as unknown as ClaudeSdkMessage;
              if (source.endsWith("throw"))
                throw new Error("Claude Code process exited with code 1");
            },
          };
        },
      }));
      await assert.rejects(
        runOneShot({
          model: { provider: "claude-sdk", modelId: "sonnet" },
          credentialProfileId: profileId,
          thinkingLevel: "low",
          systemPrompt: "system",
          prompt: "prompt",
          timeoutMs: 1000,
          timeoutMessage: "timed out",
        }),
        source.endsWith("throw") ? Error : OneShotError,
      );
      const calls = vi.mocked(reportAccountRunFailure).mock.calls;
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[0], profileId);
      assert.equal(calls[0]?.[1]?.kind, row.kind);
      assert.equal(calls[0]?.[1]?.loginDeath === true, row.loginDeath);
      assert.equal(calls[0]?.[2], "claude-sdk");
    },
  );
}
