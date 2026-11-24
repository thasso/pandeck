import { expect, test } from "vitest";
import {
  parsePendingRuntime,
  parseRuntimeAccount,
  parseRuntimeModel,
  samePendingRuntime,
  type SessionPendingRuntime,
} from "./sessionRuntime.ts";

const pending: SessionPendingRuntime = {
  model: { provider: "claude-sdk", id: "opus" },
  thinkingLevel: "high",
  account: { kind: "account", id: "cp_b" },
  setBy: "coordinator",
};

test("a stored pending selection round-trips; who chose it defaults to the user", () => {
  expect(parsePendingRuntime(JSON.parse(JSON.stringify(pending)))).toEqual(
    pending,
  );
  const { setBy: _setBy, ...unnamed } = pending;
  expect(parsePendingRuntime(unnamed)?.setBy).toBe("user");
});

test("any missing or malformed part reads as no pending selection", () => {
  for (const damaged of [
    undefined,
    null,
    "text",
    [],
    { ...pending, model: { provider: "claude-sdk" } },
    { ...pending, model: { provider: "", id: "opus" } },
    { ...pending, thinkingLevel: "maximal" },
    { ...pending, account: { kind: "account" } },
    { ...pending, account: { kind: "endpoint", id: "x" } },
    { ...pending, account: undefined },
  ])
    expect(parsePendingRuntime(damaged), JSON.stringify(damaged)).toBe(
      undefined,
    );
});

test("parts parse on their own, dropping unknown fields", () => {
  expect(parseRuntimeModel({ provider: "pi", id: "gpt", extra: 1 })).toEqual({
    provider: "pi",
    id: "gpt",
  });
  expect(parseRuntimeAccount({ kind: "automatic", id: "x" })).toEqual({
    kind: "automatic",
  });
  expect(parseRuntimeAccount({ kind: "account", id: "" })).toBe(undefined);
});

test("two selections are the same target whoever chose them", () => {
  expect(samePendingRuntime(pending, { ...pending, setBy: "user" })).toBe(true);
  expect(
    samePendingRuntime(pending, { ...pending, thinkingLevel: "low" }),
  ).toBe(false);
  expect(
    samePendingRuntime(pending, { ...pending, account: { kind: "automatic" } }),
  ).toBe(false);
  expect(samePendingRuntime(undefined, undefined)).toBe(true);
  expect(samePendingRuntime(pending, undefined)).toBe(false);
});
