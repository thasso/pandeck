/**
 * The edge's tool descriptors stay within what Pandeck accepts from a
 * listing (`remoteTools.ts`, Task-1398): the gateway's CI owns their prompt
 * budget, so a descriptor beyond these bounds fails here, not on a client.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { createEdgeTools } from "./index.ts";
import { EDGE_TOOLS } from "./tools.ts";

test("every edge tool's descriptor is within the client's bounds", () => {
  assert.ok(EDGE_TOOLS.length <= 64);
  assert.equal(
    new Set(EDGE_TOOLS.map((tool) => tool.name)).size,
    EDGE_TOOLS.length,
  );
  for (const tool of EDGE_TOOLS) {
    assert.match(tool.name, /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(
      tool.description.length >= 1 && tool.description.length <= 1_024,
      tool.name,
    );
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(JSON.stringify(tool.inputSchema).length <= 4_096, tool.name);
    // The prefix names the product Pandeck maps the tool to.
    assert.match(tool.actionKey, /^(jira):[a-z_]{1,32}$/, tool.name);
  }
});

test("the edge's tools offer the host's listing", () => {
  const listed = createEdgeTools({ log: () => {} }).host.list();
  assert.deepEqual(
    listed.map((tool) => tool.name),
    EDGE_TOOLS.map((tool) => tool.name),
  );
  const jira = listed.find((tool) => tool.name === "jira_get_issue");
  assert.ok(jira);
  assert.equal(jira.effect, "read");
  assert.equal(jira.actionKey, "jira:read");
  assert.equal(jira.inputSchema.additionalProperties, false);
});
