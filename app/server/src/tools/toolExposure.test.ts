/**
 * Tests for the harness-neutral Tools-inspector projection builder
 * (`toolExposure.ts`) and its pi integration via `toolActivation.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { buildToolExposure } from "./toolExposure.ts";
import { agentToolsFor, eagerToolNamesFor } from "./catalog.ts";
import {
  createPiToolActivation,
  toolExposureForSession,
} from "../piSdk/toolActivation.ts";

test("buildToolExposure reports groups, tiers, usability, and load state", () => {
  const eager = eagerToolNamesFor("assistant");
  const all = new Set(agentToolsFor("assistant").map((tool) => tool.name));
  const exposure = buildToolExposure({
    agentType: "assistant",
    usableToolNames: all,
    loadedToolNames: new Set([...eager, "web_fetch", "web_search"]),
    usedToolNames: new Set(["web_fetch"]),
    tokensByName: new Map([["web_fetch", 123]]),
    includeFindTools: true,
    loadEvents: [{ at: 1, via: "find_tools", names: ["web_fetch"] }],
  });
  assert.equal(
    exposure.counts.total,
    all.size + 1,
    "every catalog tool plus the loader",
  );
  assert.ok(
    exposure.counts.loaded < exposure.counts.total,
    "deferred tools stay unloaded",
  );
  const loader = exposure.tools.find((tool) => tool.name === "find_tools")!;
  assert.equal(loader.loaded, true);
  assert.equal(loader.group, "loader");
  const webFetch = exposure.tools.find((tool) => tool.name === "web_fetch")!;
  assert.equal(webFetch.loaded, true);
  assert.equal(webFetch.loading, "deferred");
  assert.equal(webFetch.tokens, 123);
  assert.equal(webFetch.used, true);
  assert.ok(webFetch.definitionChars > 0);
  assert.equal(exposure.counts.loadedButUnused, 1);
  assert.equal(
    exposure.counts.loadedButUnusedDefinitionChars,
    exposure.tools.find((tool) => tool.name === "web_search")!.definitionChars,
  );
  const jira = exposure.tools.find((tool) => tool.name === "jira_get_issue")!;
  assert.equal(jira.loaded, false);
  assert.equal(jira.groupLabel, "Jira");
  assert.deepEqual(exposure.loadEvents, [
    { at: 1, via: "find_tools", names: ["web_fetch"] },
  ]);
});

test("pi activation exposes the live projection by session id until disposed", () => {
  const sessionId = `exposure-test-${Date.now()}`;
  const activation = createPiToolActivation({
    sessionId,
    agentType: "assistant",
    agentTools: agentToolsFor("assistant"),
    eagerToolNames: eagerToolNamesFor("assistant"),
    deferToolLoading: true,
    applyActiveToolNames: () => {},
  });
  try {
    activation.initialize(["web_search"]);
    const exposure = toolExposureForSession(sessionId);
    assert.ok(exposure);
    assert.ok(
      exposure!.tools.find((tool) => tool.name === "web_search")!.loaded,
      "reopen seed counts as loaded",
    );
    assert.ok(
      !exposure!.tools.find((tool) => tool.name === "web_fetch")!.loaded,
    );
    assert.deepEqual(
      exposure!.loadEvents.map((event) => event.via),
      ["reopen"],
    );
    assert.equal(
      exposure!.counts.loaded,
      eagerToolNamesFor("assistant").size + 2,
      "eager + loader + seeded tool",
    );
  } finally {
    activation.dispose();
  }
  assert.equal(
    toolExposureForSession(sessionId),
    undefined,
    "registry entry removed on dispose",
  );
});
