import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { assistantIntegrationTools } from "./tools/catalog.ts";

/**
 * Agent tool exposure guardrail for the first-class Knowledge Base: agents get
 * the kb_* tools and no obsolete knowledge_* skill-tool surface.
 */
describe("knowledge base tool exposure", () => {
  const names = assistantIntegrationTools().map((tool) => tool.name);

  test("no obsolete knowledge_* skill tools are exposed", () => {
    const obsolete = names.filter((name) => name.startsWith("knowledge_"));
    assert.deepEqual(
      obsolete,
      [],
      `obsolete knowledge_* tools should not be exposed, found: ${obsolete.join(", ")}`,
    );
  });

  test("first-class kb_* tools are exposed", () => {
    for (const tool of [
      "kb_tree",
      "kb_search",
      "kb_get_entry",
      "kb_write_entry",
      "kb_edit_entry",
    ]) {
      assert.ok(
        names.includes(tool),
        `expected ${tool} in the assistant tool list`,
      );
    }
  });
});
