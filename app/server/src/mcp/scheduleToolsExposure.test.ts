/**
 * The Schedule tools over MCP (T6.11), as an interactive Claude session lists
 * and calls them: listed for the developer, assistant and personal-assistant
 * personas with the approved schema, deferred, discoverable by their search
 * hint; a malformed row fails alone and an all-failed call is a tool error.
 *   pnpm --filter @assistant/server test src/mcp/scheduleToolsExposure.test.ts
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentType } from "@assistant/shared";
import { scheduleStore } from "../db/scheduleStore.ts";
import {
  agentToolsFor,
  catalogSearchHintFor,
  eagerToolNamesFor,
  integrationGatedActiveToolNames,
} from "../tools/catalog.ts";
import {
  resetScheduleTools,
  seedSession,
  useSettings,
} from "../test/scheduleToolsFixture.ts";
import { mcpToolNamesFor } from "./agentToolNames.ts";
import { createSessionToolServer } from "./sessionToolServer.ts";

const SCHEDULE_TOOLS = ["schedule_read", "schedule_manage"];

interface Listed {
  tools: Array<{
    name: string;
    title?: string;
    inputSchema: unknown;
    _meta?: Record<string, unknown>;
  }>;
}
interface Called {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

beforeEach(() => useSettings());
afterEach(() => resetScheduleTools());

async function connect(agentType: AgentType, sessionId: string) {
  const tools = agentToolsFor(agentType);
  const server = createSessionToolServer({
    sessionId,
    harness: "claude-sdk",
    tools: () => tools,
    activeToolNames: () =>
      integrationGatedActiveToolNames(
        agentType,
        tools,
        new Set(tools.map((tool) => tool.name)),
      ),
    eagerToolNames: () => eagerToolNamesFor(agentType),
    searchHint: (tool) => catalogSearchHintFor(agentType, tool.name),
    session: () => ({ sessionId, harness: "claude-sdk", agentType }),
  });
  const client = new Client(
    { name: "schedule-tools-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    tools,
    close: async () => {
      await client.close();
      await server.close().catch(() => {});
    },
  };
}

describe("T6.11 Schedule tools over MCP", () => {
  for (const persona of [
    "developer",
    "assistant",
    "personal-assistant",
  ] as const)
    it(`${persona} lists both, deferred, with the approved schema and hint`, async () => {
      const { client, tools, close } = await connect(persona, seedSession());
      try {
        const listed = (await client.listTools()) as Listed;
        for (const name of SCHEDULE_TOOLS) {
          const entry = listed.tools.find((tool) => tool.name === name);
          const tool = tools.find((candidate) => candidate.name === name)!;
          assert.ok(entry, `${persona} lists ${name}`);
          assert.equal(entry.title, tool.label);
          assert.deepEqual(entry.inputSchema, tool.parameters);
          assert.equal(entry._meta?.["anthropic/alwaysLoad"], undefined);
          assert.equal(entry._meta?.["anthropic/searchHint"], tool.searchHint);
        }
        for (const name of SCHEDULE_TOOLS)
          assert.ok(mcpToolNamesFor(persona).includes(`mcp__pa__${name}`));
      } finally {
        await close();
      }
    });

  it("workshop does not list them", () => {
    for (const name of SCHEDULE_TOOLS)
      assert.ok(!mcpToolNamesFor("workshop").includes(`mcp__pa__${name}`));
  });

  it("isolates a malformed row, and reports an all-failed call as a tool error", async () => {
    const me = seedSession();
    const { client, close } = await connect("developer", me);
    const create = {
      operation: "create",
      name: "Check",
      prompt: "Check CI for PR #382 in pandeck; merge if green.",
      targetSessionId: me,
      timing: { kind: "once", at: "in 45m" },
    };
    try {
      const mixed = (await client.callTool({
        name: "schedule_manage",
        arguments: {
          operations: [create, "junk", { ...create, enabled: "yes" }, create],
        },
      })) as Called;
      assert.ok(!mixed.isError, JSON.stringify(mixed.content));
      const results = (
        JSON.parse(mixed.content[0]!.text!) as {
          results: Array<{ ok: boolean; error?: string }>;
        }
      ).results;
      assert.deepEqual(
        results.map((r) => r.error ?? "ok"),
        [
          "ok",
          "An operation must be an object.",
          "enabled must be a boolean.",
          "ok",
        ],
      );
      assert.equal(scheduleStore.list().length, 2);

      const failed = (await client.callTool({
        name: "schedule_manage",
        arguments: { operations: [{ operation: "delete", id: "sch_none" }] },
      })) as Called;
      assert.equal(failed.isError, true);
      assert.match(failed.content[0]!.text!, /Schedule not found: sch_none/);

      const read = (await client.callTool({
        name: "schedule_read",
        arguments: {},
      })) as Called;
      assert.ok(!read.isError, JSON.stringify(read.content));
      assert.equal(
        (JSON.parse(read.content[0]!.text!) as { count: number }).count,
        2,
      );
    } finally {
      await close();
    }
  });
});
