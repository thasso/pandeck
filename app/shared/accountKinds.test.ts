/**
 * The account-kind table and the predicates that decide which account may run
 * a model (`docs/account-routing.md`): a compatible model runs on exactly the
 * one account whose id is its provider, and never across kinds.
 */
import { expect, test } from "vitest";
import {
  accountPinForModel,
  accountServesModel,
  ACCOUNT_KINDS,
  isAccountKind,
  isOpenAiCompatibleModelProvider,
  isSubscriptionAccountKind,
  piAccountServesModel,
} from "./accountKinds.ts";
import { CLAUDE_SDK_PROVIDER, HARNESSES } from "./harnesses.ts";
import type { CredentialProfileProvider } from "./protocol.ts";

const KINDS = Object.keys(ACCOUNT_KINDS) as CredentialProfileProvider[];
const NEW_COMPATIBLE = "openai-compatible-0123456789ab";

test("every kind has a descriptor whose harness exists, and only logins are subscriptions", () => {
  expect(KINDS.sort()).toEqual(["claude", "openai-codex", "openai-compatible"]);
  for (const kind of KINDS) {
    const descriptor = ACCOUNT_KINDS[kind];
    expect(Object.keys(HARNESSES)).toContain(descriptor.harness);
    expect(isSubscriptionAccountKind(kind)).toBe(descriptor.subscription);
    expect(descriptor.subscription).toBe(descriptor.credential === "login");
    expect(descriptor.usagePage).toBe(descriptor.subscription);
    expect(descriptor.subscriptionModelProvider !== undefined).toBe(
      descriptor.subscription,
    );
  }
  expect(isAccountKind("openai-compatible")).toBe(true);
  for (const value of ["toString", "openai", "", undefined, 1])
    expect(isAccountKind(value)).toBe(false);
});

test("only the plain id and a 12-hex suffix are compatible provider ids", () => {
  for (const id of ["openai-compatible", NEW_COMPATIBLE])
    expect(isOpenAiCompatibleModelProvider(id)).toBe(true);
  for (const id of [
    undefined,
    "",
    "openai",
    "openai-codex",
    "openai-compatible-",
    "openai-compatible-0123456789a",
    "openai-compatible-0123456789abc",
    "openai-compatible-0123456789AB",
    "openai-compatible-012345678g9a",
    "xopenai-compatible",
    `${NEW_COMPATIBLE}\n`,
  ])
    expect(isOpenAiCompatibleModelProvider(id)).toBe(false);
});

test("a compatible model runs on its own account alone; no account serves across kinds", () => {
  const accounts = [
    { id: "default", provider: "openai-codex" },
    { id: "claude-default", provider: "claude" },
    { id: "openai-compatible", provider: "openai-compatible" },
    { id: NEW_COMPATIBLE, provider: "openai-compatible" },
  ] as const;
  const served = (modelProvider: string) =>
    accounts
      .filter((account) => accountServesModel(account, modelProvider))
      .map((account) => account.id);
  expect(served("openai-compatible")).toEqual(["openai-compatible"]);
  expect(served(NEW_COMPATIBLE)).toEqual([NEW_COMPATIBLE]);
  expect(served("openai-compatible-ffffffffffff")).toEqual([]);
  expect(served("openai-codex")).toEqual(["default"]);
  expect(served("openai")).toEqual(["default"]);
  expect(served(CLAUDE_SDK_PROVIDER)).toEqual(["claude-default"]);

  // The Worker's id-only form agrees for every pi account.
  for (const account of accounts.filter((a) => a.provider !== "claude"))
    for (const modelProvider of [
      "openai-compatible",
      NEW_COMPATIBLE,
      "openai-codex",
      "openai",
      CLAUDE_SDK_PROVIDER,
    ])
      expect(piAccountServesModel(account.id, modelProvider)).toBe(
        accountServesModel(account, modelProvider),
      );
});

test("rule P: a compatible model's pin is its account, whatever was stored", () => {
  expect(accountPinForModel(NEW_COMPATIBLE, "default")).toBe(NEW_COMPATIBLE);
  expect(accountPinForModel(NEW_COMPATIBLE, undefined)).toBe(NEW_COMPATIBLE);
  expect(accountPinForModel("openai-codex", "cp_0123456789abcdef")).toBe(
    "cp_0123456789abcdef",
  );
  expect(accountPinForModel("openai-codex", undefined)).toBeUndefined();
});
