/**
 * A session shown from storage reports the model and thinking level its row
 * records — for both harnesses — so the composer does not fall back to "Select
 * model" until the first prompt opens the harness.
 *
 *   pnpm --filter @assistant/server test src/viewSession.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "view-session-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { sessionStore } = await import("./db/sessionStore.ts");
const { viewSessionById } = await import("./viewSession.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("a stored Claude SDK session reports its model by alias", () => {
  // The Claude SDK store records its credential kind as the provider.
  sessionStore.upsert({
    id: "view-claude",
    harness: "claude-sdk",
    agentType: "developer",
    provider: "claude",
    model: "opus",
    thinkingLevel: "high",
  });
  const state = viewSessionById("view-claude")?.state();
  expect(state?.model).toMatchObject({ provider: "claude-sdk", id: "opus" });
  expect(state?.thinkingLevel).toBe("high");

  sessionStore.upsert({
    id: "view-claude",
    harness: "claude-sdk",
    agentType: "developer",
    model: "claude-opus-5-5[1m]",
  });
  expect(viewSessionById("view-claude")?.state().model).toMatchObject({
    provider: "claude-sdk",
    id: "opus",
  });
});

test("a stored pi session reports its catalog model", () => {
  sessionStore.upsert({
    id: "view-pi",
    harness: "pi",
    agentType: "developer",
    provider: "openai-codex",
    model: "gpt-6-sol",
    thinkingLevel: "high",
  });
  const state = viewSessionById("view-pi")?.state();
  expect(state?.model).toMatchObject({
    provider: "openai-codex",
    id: "gpt-6-sol",
  });
  expect(state?.thinkingLevel).toBe("high");
});

test("an id no catalog offers resolves to no model rather than a guess", () => {
  sessionStore.upsert({
    id: "view-unknown",
    harness: "claude-sdk",
    agentType: "developer",
    provider: "claude",
    model: "retired-model",
  });
  expect(viewSessionById("view-unknown")?.state().model).toBeUndefined();
});
