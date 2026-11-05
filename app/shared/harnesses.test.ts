/**
 * The harness table and the translation between a harness's id and its
 * model-picker provider. Which account runs a model is `accountKinds.ts`.
 */
import { expect, test } from "vitest";
import {
  backgroundWorkBackendsForHarness,
  CLAUDE_SDK_PROVIDER,
  HARNESSES,
  harnessForModelProvider,
  harnessSupportsBackgroundWorkBackend,
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
  }
  // The native backend first: it is the one each harness's own tools admit
  // under. Both may own server tasks, which neither engine runs.
  expect(backgroundWorkBackendsForHarness("pi")).toEqual([
    "host-process",
    "server-task",
  ]);
  expect(backgroundWorkBackendsForHarness("claude-sdk")).toEqual([
    "claude-query",
    "server-task",
  ]);
  for (const id of HARNESS_IDS)
    expect(harnessSupportsBackgroundWorkBackend(id, "server-task")).toBe(true);
});
