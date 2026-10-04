/**
 * The harness table and the translations between the three names a harness
 * goes by: its id, its account kind and its model-picker provider.
 */
import { expect, test } from "vitest";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./protocol.ts";
import {
  accountProviderForModelProvider,
  backgroundWorkBackendsForHarness,
  CLAUDE_SDK_PROVIDER,
  HARNESSES,
  harnessForAccountProvider,
  harnessForModelProvider,
  type Harness,
} from "./harnesses.ts";

const HARNESS_IDS: Harness[] = ["pi", "claude-sdk"];

test("every descriptor is keyed by its own id", () => {
  for (const id of HARNESS_IDS) expect(HARNESSES[id].id).toBe(id);
});

test("a Claude SDK model runs on the Claude harness; any other on pi", () => {
  expect(harnessForModelProvider(CLAUDE_SDK_PROVIDER)).toBe("claude-sdk");
  expect(harnessForModelProvider("github-copilot")).toBe("pi");
  expect(harnessForModelProvider("openai-codex")).toBe("pi");
  expect(harnessForModelProvider(undefined)).toBe("pi");
});

test("account kinds and model providers translate consistently", () => {
  expect(accountProviderForModelProvider(CLAUDE_SDK_PROVIDER)).toBe("claude");
  expect(accountProviderForModelProvider("github-copilot")).toBe(
    "openai-codex",
  );
  expect(accountProviderForModelProvider(OPENAI_COMPATIBLE_PROVIDER_ID)).toBe(
    "openai-codex",
  );
  expect(harnessForAccountProvider("claude")).toBe("claude-sdk");
  expect(harnessForAccountProvider("openai-codex")).toBe("pi");
  for (const id of HARNESS_IDS)
    expect(harnessForAccountProvider(HARNESSES[id].accountProvider)).toBe(id);
});

test("only a harness with one picker provider names it", () => {
  expect(HARNESSES["claude-sdk"].modelProvider).toBe(CLAUDE_SDK_PROVIDER);
  expect(HARNESSES.pi.modelProvider).toBeUndefined();
  for (const id of HARNESS_IDS) {
    const provider = HARNESSES[id].modelProvider;
    if (provider !== undefined)
      expect(harnessForModelProvider(provider)).toBe(id);
  }
});

test("every harness owns at least one background-work backend", () => {
  for (const id of HARNESS_IDS) {
    expect(backgroundWorkBackendsForHarness(id).length).toBeGreaterThan(0);
    expect(backgroundWorkBackendsForHarness(id)).toBe(
      HARNESSES[id].backgroundWorkBackends,
    );
  }
});
