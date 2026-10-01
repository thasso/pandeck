import { describe, expect, test } from "vitest";
import {
  normalizeTextScale,
  normalizeWorkflowRoleRuntimes,
} from "./usePrefs.ts";

describe("normalizeTextScale", () => {
  test("keeps every supported value", () => {
    expect(normalizeTextScale(100)).toBe(100);
    expect(normalizeTextScale(110)).toBe(110);
    expect(normalizeTextScale(120)).toBe(120);
    expect(normalizeTextScale(130)).toBe(130);
  });

  test("coerces numeric strings to the supported value", () => {
    expect(normalizeTextScale("120")).toBe(120);
  });

  test("falls back to 100 for unknown, malformed, or out-of-range input", () => {
    expect(normalizeTextScale(undefined)).toBe(100);
    expect(normalizeTextScale(null)).toBe(100);
    expect(normalizeTextScale(0)).toBe(100);
    expect(normalizeTextScale(90)).toBe(100);
    expect(normalizeTextScale(140)).toBe(100);
    expect(normalizeTextScale(115)).toBe(100);
    expect(normalizeTextScale("huge")).toBe(100);
    expect(normalizeTextScale({})).toBe(100);
    expect(normalizeTextScale(NaN)).toBe(100);
  });
});

describe("normalizeWorkflowRoleRuntimes", () => {
  const coordinator = {
    modelKey: "claude-sdk:claude-haiku-4-5",
    thinkingLevel: "low" as const,
  };
  const sonnet = {
    modelKey: "claude-sdk:claude-sonnet-5",
    credentialProfileId: "acc-1",
    thinkingLevel: "medium" as const,
  };
  const gpt = {
    modelKey: "openai-codex:gpt-5.6",
    thinkingLevel: "high" as const,
  };

  test("keeps four role sets in today's shape", () => {
    const roles = {
      implementer: [sonnet],
      reviewer: [gpt],
      fixer: [],
      verdict: [sonnet],
    };
    expect(normalizeWorkflowRoleRuntimes({ coordinator, roles })).toEqual({
      coordinator,
      roles,
    });
  });

  test("repairs missing or malformed individual set arrays", () => {
    expect(
      normalizeWorkflowRoleRuntimes({
        roles: { implementer: [sonnet], reviewer: "bad", fixer: [gpt] },
      }),
    ).toEqual({
      roles: {
        implementer: [sonnet],
        reviewer: [],
        fixer: [gpt],
        verdict: [],
      },
    });
  });

  test("drops the superseded flat allowlist preference", () => {
    expect(
      normalizeWorkflowRoleRuntimes({ coordinator, workers: [sonnet] }),
    ).toBeUndefined();
  });

  test("answers nothing for nothing stored", () => {
    expect(normalizeWorkflowRoleRuntimes(undefined)).toBeUndefined();
    expect(normalizeWorkflowRoleRuntimes(null)).toBeUndefined();
    expect(normalizeWorkflowRoleRuntimes("workerA")).toBeUndefined();
  });
});
