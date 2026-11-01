import assert from "node:assert/strict";
import { test } from "vitest";
import { hasNativeTools } from "@assistant/shared";
import {
  PI_SEARCH_BUILTIN_TOOLS,
  PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
} from "./options.ts";
import { buildAgentOptions } from "./piEngineStart.ts";
import { mergedActiveToolNames } from "./toolActivation.ts";

for (const persona of [
  "personal-assistant",
  "assistant",
  "workflow-coordinator",
  "developer",
] as const) {
  test(`${persona} pi native tools follow the shared capability`, async () => {
    const options = await buildAgentOptions(persona);
    assert.equal(
      options.noTools,
      hasNativeTools(persona) ? undefined : "builtin",
    );
    assert.deepEqual(
      options.extraBuiltinToolNames,
      hasNativeTools(persona) ? [...PI_SEARCH_BUILTIN_TOOLS] : [],
    );
    const builtin = options.noTools ? [] : ["read", "bash", "edit", "write"];
    const plan = new Set(
      mergedActiveToolNames({
        current: builtin,
        bridgeToolNames: new Set<string>(),
        extraBuiltin: options.extraBuiltinToolNames,
        planRestrictedBuiltin: PI_PLAN_RESTRICTED_BUILTIN_TOOLS,
        mode: "plan",
        activeBridge: new Set<string>(),
      }),
    );
    assert.equal(plan.has("read"), hasNativeTools(persona));
    assert.equal(plan.has("bash"), hasNativeTools(persona));
    assert.equal(plan.has("edit"), false);
    assert.equal(plan.has("write"), false);
  });
}
