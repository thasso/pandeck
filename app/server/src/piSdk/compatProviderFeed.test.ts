/**
 * Until the gateway serves each OpenAI-compatible account, leased engines get
 * no compatible provider (`compatProviderFeed.ts`, `docs/workers.md`): the
 * feed is empty and silent even while a ready compatible account exists.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  createCredentialProfile,
  deleteCredentialProfile,
  patchOpenAiCompatibleEndpoint,
} from "../credentialProfiles.ts";
import {
  readOpenAiCompatibleEndpoint,
  writeOpenAiCompatibleEndpoint,
} from "../openAiCompatibleAccounts.ts";
import { COMPAT_KEY_A } from "../test/gatewayFixtures.ts";
import { compatProviderFeed } from "./compatProviderFeed.ts";

const created: string[] = [];

afterEach(() => {
  for (const id of created.splice(0)) deleteCredentialProfile(id);
});

test("the feed holds nothing and never notifies, with a ready account", () => {
  const { id } = createCredentialProfile({
    name: "Ready",
    provider: "openai-compatible",
  });
  created.push(id);
  const calls: string[] = [];
  const unsubscribe = compatProviderFeed.subscribe(() => calls.push("heard"));
  patchOpenAiCompatibleEndpoint(id, {
    baseUrl: "http://compat-a.test/v1",
    apiKey: COMPAT_KEY_A,
  });
  writeOpenAiCompatibleEndpoint(id, {
    ...readOpenAiCompatibleEndpoint(id),
    models: [
      {
        id: "m",
        name: "m",
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 100,
        reasoning: false,
      },
    ],
  });
  assert.equal(compatProviderFeed.current(), undefined);
  assert.deepEqual(calls, []);
  unsubscribe();
});
