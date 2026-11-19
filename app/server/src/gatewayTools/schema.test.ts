/**
 * The edge's closed argument checker (`schema.ts`): finite numbers, string
 * enums and string arrays (Task-1439) beside the existing string, boolean and
 * integer rules. A refusal names the schema's property, never a value.
 */
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { encodeAtlassianCredential } from "./atlassian.ts";
import type { ObjectSchema } from "./descriptor.ts";
import { createToolHost, type ToolCaller } from "./host.ts";
import { checkArguments } from "./schema.ts";
import { EDGE_TOOLS } from "./tools.ts";

const SENTINEL = "SENTINEL-value-do-not-echo";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jql"],
  properties: {
    jql: { type: "string" },
    maxResults: { type: "number" },
    kind: { type: "string", enum: ["fields", "projects"] },
    fields: { type: "array", items: { type: "string" } },
    states: {
      type: "array",
      items: { type: "string", enum: ["future", "active", "closed"] },
    },
    flag: { type: "boolean" },
    count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
    issue: { type: "string", pattern: "^[A-Z]+-\\d+$", maxLength: 20 },
  },
} as const satisfies ObjectSchema;

function refusal(args: Record<string, unknown>): string {
  const check = checkArguments(SCHEMA, { jql: "x", ...args });
  assert.ok(!check.ok, JSON.stringify(args));
  assert.ok(!check.message.includes(SENTINEL), check.message);
  return check.message;
}

function accepted(args: Record<string, unknown>): Record<string, unknown> {
  const check = checkArguments(SCHEMA, { jql: "x", ...args });
  assert.ok(check.ok, JSON.stringify(args));
  return check.params;
}

afterEach(() => vi.unstubAllGlobals());

test("a number is any finite number", () => {
  assert.equal(accepted({ maxResults: 2.5 }).maxResults, 2.5);
  assert.equal(accepted({ maxResults: 0 }).maxResults, 0);
  for (const maxResults of ["5", Number.NaN, Infinity, -Infinity, null])
    assert.equal(
      refusal({ maxResults }),
      "Invalid arguments: maxResults must be a number.",
    );
});

test("a string enum takes only its listed values", () => {
  assert.equal(accepted({ kind: "projects" }).kind, "projects");
  assert.equal(
    refusal({ kind: SENTINEL }),
    "Invalid arguments: kind must be one of the listed values.",
  );
  assert.equal(
    refusal({ kind: 3 }),
    "Invalid arguments: kind must be a string.",
  );
});

test("an array holds only strings, each listed when the items carry an enum", () => {
  assert.deepEqual(accepted({ fields: [] }).fields, []);
  assert.deepEqual(accepted({ fields: ["a"] }).fields, ["a"]);
  assert.deepEqual(accepted({ states: ["active", "closed"] }).states, [
    "active",
    "closed",
  ]);
  for (const fields of [SENTINEL, [1], [SENTINEL, 2], { 0: "a" }, null])
    assert.equal(
      refusal({ fields }),
      "Invalid arguments: fields must be a list of strings.",
    );
  assert.equal(
    refusal({ states: ["active", SENTINEL] }),
    "Invalid arguments: states must hold only the listed values.",
  );
});

test("string, boolean and integer rules are unchanged", () => {
  assert.deepEqual(accepted({}), { jql: "x", count: 2 });
  assert.equal(
    refusal({ jql: undefined }),
    "Invalid arguments: jql is required.",
  );
  assert.equal(
    refusal({ flag: SENTINEL }),
    "Invalid arguments: flag must be a boolean.",
  );
  assert.equal(
    refusal({ count: 1.5 }),
    "Invalid arguments: count must be an integer.",
  );
  assert.equal(
    refusal({ count: 6 }),
    "Invalid arguments: count is out of range.",
  );
  assert.equal(
    refusal({ issue: "SENTINEL" }),
    "Invalid arguments: issue does not have the expected form.",
  );
  assert.equal(
    refusal({ issue: "A-".padEnd(21, "1") }),
    "Invalid arguments: issue is too long.",
  );
  assert.equal(
    refusal({ [SENTINEL]: 1 }),
    "Invalid arguments: an unknown property was given.",
  );
});

test("a number beyond float range in raw JSON is refused before any fetch", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const caller: ToolCaller = {
    clientId: "client-1",
    credential: () =>
      Promise.resolve({
        ok: true,
        credential: encodeAtlassianCredential({
          site: "acme.atlassian.net",
          email: "a@x.test",
          token: "fake-1",
        }),
      }),
  };
  const host = createToolHost(EDGE_TOOLS, { log: () => {} });
  const answer = await host.call(
    "jira_search_issues",
    JSON.parse('{"jql":"x","maxResults":1e309}'),
    caller,
  );
  assert.deepEqual(answer, {
    ok: false,
    code: "invalid_params",
    message: "Invalid arguments: maxResults must be a number.",
  });
  assert.equal(fetch.mock.calls.length, 0);
});
