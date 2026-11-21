/**
 * The edge's closed argument checker (`schema.ts`): finite numbers, string
 * enums and string arrays (Task-1439) beside the existing string, boolean and
 * integer rules; closed nested objects, bounded arrays, string-or-null and
 * opaque objects (Task-1463), with type fixtures for the schema's exclusive
 * branches. A refusal names the schema's property path, never a value.
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

// ---------------------------------------------- nested schemas (Task-1463)

/** Positive fixture (a): the local `jira_mutate_issue` shape, written out. */
const JIRA_MUTATE = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "Jira issue mutation proposals.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            type: "string",
            enum: ["edit", "create", "comment", "rank", "sprint"],
          },
          issue: { type: "string", description: "Jira issue key or id." },
          description: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "Markdown, or null to clear it.",
          },
          assigneeAccountId: { anyOf: [{ type: "string" }, { type: "null" }] },
          clearAssignee: { type: "boolean" },
          labels: {
            type: "object",
            additionalProperties: false,
            properties: {
              set: { type: "array", items: { type: "string" } },
              add: { type: "array", items: { type: "string" } },
              remove: { type: "array", items: { type: "string" } },
            },
          },
          fields: { type: "object", description: "Advanced field updates." },
          rankIssues: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
          },
          rankBoardId: { type: "integer" },
          linkChanges: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["op"],
              properties: {
                op: { type: "string", enum: ["add", "remove"] },
                type: { type: "string" },
                direction: { type: "string", enum: ["inward", "outward"] },
                issue: { type: "string" },
                linkId: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies ObjectSchema;

/** Positive fixture (b): an opaque object at the root. */
const OPAQUE = {
  type: "object",
  additionalProperties: false,
  properties: { fields: { type: "object", description: "Any JSON object." } },
} as const satisfies ObjectSchema;

/** Positive fixture (c): a closed empty object. */
const EMPTY = {
  type: "object",
  additionalProperties: false,
  properties: {
    empty: { type: "object", properties: {}, additionalProperties: false },
  },
} as const satisfies ObjectSchema;

/** Root-level closed object, bounded arrays and a default; nothing required. */
const PARTS = {
  type: "object",
  additionalProperties: false,
  properties: {
    labels: {
      type: "object",
      additionalProperties: false,
      properties: {
        set: { type: "array", items: { type: "string" } },
        add: { type: "array", items: { type: "string" } },
      },
    },
    rankIssues: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 50,
    },
    kinds: {
      type: "array",
      items: { type: "string", enum: ["a", "b"] },
      maxItems: 2,
    },
    count: { type: "integer", default: 2 },
  },
} as const satisfies ObjectSchema;

function refusedBy(schema: ObjectSchema, args: unknown): string {
  const check = checkArguments(schema, args);
  assert.ok(!check.ok, JSON.stringify(args));
  assert.ok(!check.message.includes(SENTINEL), check.message);
  return check.message;
}

function acceptedBy(
  schema: ObjectSchema,
  args: unknown,
): Record<string, unknown> {
  const check = checkArguments(schema, args);
  assert.ok(check.ok, JSON.stringify(args));
  return check.params;
}

/** The accepted form of one Jira item, given alone. */
function acceptedItem(item: Record<string, unknown>): Record<string, unknown> {
  const items = acceptedBy(JIRA_MUTATE, { items: [item] }).items;
  assert.ok(Array.isArray(items));
  return items[0] as Record<string, unknown>;
}

const itemRefusal = (item: Record<string, unknown>): string =>
  refusedBy(JIRA_MUTATE, { items: [item] });

test("a closed nested object is checked like the root and rebuilt from schema names", () => {
  const labels = { set: ["a"] };
  const params = acceptedBy(PARTS, { labels });
  assert.deepEqual(params.labels, { set: ["a"] });
  assert.notEqual(params.labels, labels);
  assert.deepEqual(acceptedBy(PARTS, { labels: { add: ["b"] } }).labels, {
    add: ["b"],
  });
  for (const labels of [[], null, "x", SENTINEL, 3])
    assert.equal(
      refusedBy(PARTS, { labels }),
      "Invalid arguments: labels must be an object.",
    );
  for (const labels of [
    { x: 1 },
    { [SENTINEL]: 1 },
    { set: [], [SENTINEL]: SENTINEL },
  ])
    assert.equal(
      refusedBy(PARTS, { labels }),
      "Invalid arguments: labels has an unknown property.",
    );
  assert.equal(
    refusedBy(PARTS, { labels: { set: [SENTINEL, 1] } }),
    "Invalid arguments: labels.set must be a list of strings.",
  );
  assert.equal(
    itemRefusal({ labels: { remove: SENTINEL } }),
    "Invalid arguments: items[0].labels.remove must be a list of strings.",
  );
  assert.equal(
    itemRefusal({ linkChanges: [{ type: SENTINEL }] }),
    "Invalid arguments: items[0].linkChanges[0].op is required.",
  );
  assert.equal(
    itemRefusal({ linkChanges: [{ op: SENTINEL }] }),
    "Invalid arguments: items[0].linkChanges[0].op must be one of the listed values.",
  );
  assert.deepEqual(
    acceptedItem({ linkChanges: [{ op: "remove", linkId: "7" }] }),
    {
      linkChanges: [{ op: "remove", linkId: "7" }],
    },
  );
});

test("a closed empty object takes only an empty object", () => {
  assert.deepEqual(acceptedBy(EMPTY, { empty: {} }), { empty: {} });
  assert.equal(
    refusedBy(EMPTY, { empty: { x: 1 } }),
    "Invalid arguments: empty has an unknown property.",
  );
  assert.equal(
    refusedBy(EMPTY, { empty: { [SENTINEL]: SENTINEL } }),
    "Invalid arguments: empty has an unknown property.",
  );
});

test("an array of closed objects is bounded and checks each item at its index", () => {
  const item = { operation: "comment", issue: "A-1" };
  assert.equal(
    refusedBy(JIRA_MUTATE, { items: [] }),
    "Invalid arguments: items must hold at least 1 item(s).",
  );
  assert.equal(
    refusedBy(JIRA_MUTATE, { items: Array.from({ length: 11 }, () => item) }),
    "Invalid arguments: items must hold at most 10 item(s).",
  );
  for (const length of [1, 10]) {
    const given = Array.from({ length }, () => item);
    const items = acceptedBy(JIRA_MUTATE, { items: given }).items;
    assert.deepEqual(items, given);
    assert.notEqual(items, given);
    assert.ok(Array.isArray(items));
    assert.notEqual(items[0], item);
  }
  for (const bad of [1, null, [], SENTINEL])
    assert.equal(
      refusedBy(JIRA_MUTATE, { items: [bad] }),
      "Invalid arguments: items[0] must be an object.",
    );
  for (const items of [{}, { 0: item }, SENTINEL, null])
    assert.equal(
      refusedBy(JIRA_MUTATE, { items }),
      "Invalid arguments: items must be a list.",
    );
  assert.equal(
    refusedBy(JIRA_MUTATE, { items: [item, { [SENTINEL]: 1 }] }),
    "Invalid arguments: items[1] has an unknown property.",
  );
  assert.equal(
    refusedBy(JIRA_MUTATE, {}),
    "Invalid arguments: items is required.",
  );
});

test("a string array keeps its type check first, then its bounds, then its enum", () => {
  assert.equal(
    refusedBy(PARTS, { rankIssues: [] }),
    "Invalid arguments: rankIssues must hold at least 1 item(s).",
  );
  assert.equal(
    refusedBy(PARTS, { rankIssues: Array.from({ length: 51 }, () => "A-1") }),
    "Invalid arguments: rankIssues must hold at most 50 item(s).",
  );
  for (const length of [1, 50]) {
    const rankIssues = Array.from({ length }, () => "A-1");
    assert.equal(acceptedBy(PARTS, { rankIssues }).rankIssues, rankIssues);
  }
  assert.equal(
    refusedBy(PARTS, { rankIssues: Array.from({ length: 51 }, () => 3) }),
    "Invalid arguments: rankIssues must be a list of strings.",
  );
  assert.equal(
    refusedBy(PARTS, { kinds: ["a", "b", SENTINEL] }),
    "Invalid arguments: kinds must hold at most 2 item(s).",
  );
  assert.equal(
    refusedBy(PARTS, { kinds: ["a", SENTINEL] }),
    "Invalid arguments: kinds must hold only the listed values.",
  );
  assert.equal(
    itemRefusal({ rankIssues: [] }),
    "Invalid arguments: items[0].rankIssues must hold at least 1 item(s).",
  );
});

test("a string-or-null takes a string or null and passes null on", () => {
  assert.equal(acceptedItem({ description: null }).description, null);
  assert.equal(acceptedItem({ description: "text" }).description, "text");
  assert.ok(!("description" in acceptedItem({ issue: "A-1" })));
  for (const description of [3, false, {}, [SENTINEL]])
    assert.equal(
      itemRefusal({ description }),
      "Invalid arguments: items[0].description must be a string or null.",
    );
});

test("an opaque object is any object, passed on as the same reference", () => {
  const fields = { customfield_1: { a: [1] }, [SENTINEL]: SENTINEL };
  assert.equal(acceptedBy(OPAQUE, { fields }).fields, fields);
  assert.equal(acceptedItem({ fields }).fields, fields);
  for (const fields of [[], null, "x", SENTINEL, 1])
    assert.equal(
      refusedBy(OPAQUE, { fields }),
      "Invalid arguments: fields must be an object.",
    );
  assert.equal(
    itemRefusal({ fields: [SENTINEL] }),
    "Invalid arguments: items[0].fields must be an object.",
  );
});

test("an own __proto__ passes inside an opaque value and is refused anywhere closed", () => {
  assert.ok(!Object.hasOwn(Object.prototype, "polluted"));
  const fields = JSON.parse(
    '{"customfield_1":{"__proto__":{"polluted":true}}}',
  ) as Record<string, unknown>;
  const passed = acceptedBy(OPAQUE, { fields }).fields;
  assert.equal(passed, fields);
  assert.ok(
    Object.hasOwn(
      (passed as Record<string, unknown>).customfield_1 as object,
      "__proto__",
    ),
  );
  assert.equal(
    refusedBy(SCHEMA, JSON.parse('{"jql":"x","__proto__":{"polluted":true}}')),
    "Invalid arguments: an unknown property was given.",
  );
  assert.equal(
    refusedBy(PARTS, { labels: JSON.parse('{"__proto__":{}}') }),
    "Invalid arguments: labels has an unknown property.",
  );
  assert.equal(
    refusedBy(JIRA_MUTATE, {
      items: [JSON.parse('{"__proto__":{"polluted":true}}')],
    }),
    "Invalid arguments: items[0] has an unknown property.",
  );
  assert.ok(!Object.hasOwn(Object.prototype, "polluted"));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("top-level precedence, defaults, null and missing arguments are unchanged", () => {
  assert.equal(
    refusedBy(SCHEMA, { [SENTINEL]: 1 }),
    "Invalid arguments: an unknown property was given.",
  );
  assert.deepEqual(accepted({}), { jql: "x", count: 2 });
  assert.ok(!("flag" in accepted({})));
  assert.equal(accepted({ count: 3 }).count, 3);
  assert.equal(
    refusal({ jql: null }),
    "Invalid arguments: jql must be a string.",
  );
  assert.equal(
    refusal({ flag: null }),
    "Invalid arguments: flag must be a boolean.",
  );
  assert.equal(
    refusal({ count: null }),
    "Invalid arguments: count must be an integer.",
  );
  assert.equal(
    refusal({ states: ["active", 3] }),
    "Invalid arguments: states must be a list of strings.",
  );
  for (const args of [undefined, null])
    assert.equal(
      refusedBy(SCHEMA, args),
      "Invalid arguments: jql is required.",
    );
  for (const args of [undefined, null])
    assert.deepEqual(acceptedBy(PARTS, args), { count: 2 });
  for (const args of [[], "x"])
    assert.equal(
      refusedBy(SCHEMA, args),
      "Invalid arguments: an object is required.",
    );
});

test("the valid counterparts of the refused type fixtures are working schemas", () => {
  for (const schema of VALID_COUNTERPARTS) {
    acceptedBy(schema, {});
    assert.equal(
      refusedBy(schema, { [SENTINEL]: 1 }),
      "Invalid arguments: an unknown property was given.",
    );
  }
});

// ------------------------------------------------- type fixtures (Task-1463)
// Each refused fixture is a whole root schema whose one `bad` property holds
// the malformed shape beside a valid `ok` one; its valid counterpart differs
// only in that shape. A fixture that compiled would leave its
// `@ts-expect-error` unused, which fails typecheck.

const ok = { type: "string" } as const;

// 1. A closed object with `properties` but no `additionalProperties`.
const refused1 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- a closed object needs `additionalProperties: false`
    bad: { type: "object", properties: { x: { type: "string" } } },
  },
} as const satisfies ObjectSchema;
const valid1 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      properties: { x: { type: "string" } },
      additionalProperties: false,
    },
  },
} as const satisfies ObjectSchema;

// 2. A closed object with `additionalProperties: true`.
const refused2 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      properties: { x: { type: "string" } },
      // @ts-expect-error -- a closed object's `additionalProperties` is only `false`
      additionalProperties: true,
    },
  },
} as const satisfies ObjectSchema;
const valid2 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      properties: { x: { type: "string" } },
      additionalProperties: false,
    },
  },
} as const satisfies ObjectSchema;

// 3. `required` without `properties`.
const refused3 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- `required` needs `properties`; an opaque object has neither
    bad: { type: "object", required: ["x"] },
  },
} as const satisfies ObjectSchema;
const valid3 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    },
  },
} as const satisfies ObjectSchema;

// 4. `additionalProperties: false` without `properties`.
const refused4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- `additionalProperties: false` needs `properties`
    bad: { type: "object", additionalProperties: false },
  },
} as const satisfies ObjectSchema;
const valid4 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: { type: "object", properties: {}, additionalProperties: false },
  },
} as const satisfies ObjectSchema;

// 5a. A nested boolean `default`.
const refused5a = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", default: true },
    bad: {
      type: "object",
      additionalProperties: false,
      // @ts-expect-error -- a nested boolean takes no `default`
      properties: { flag: { type: "boolean", default: true } },
    },
  },
} as const satisfies ObjectSchema;
const valid5a = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", default: true },
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { flag: { type: "boolean" } },
    },
  },
} as const satisfies ObjectSchema;

// 5b. A nested integer `default`.
const refused5b = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "integer", default: 1 },
    bad: {
      type: "object",
      additionalProperties: false,
      // @ts-expect-error -- a nested integer takes no `default`
      properties: { count: { type: "integer", default: 1 } },
    },
  },
} as const satisfies ObjectSchema;
const valid5b = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "integer", default: 1 },
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { count: { type: "integer" } },
    },
  },
} as const satisfies ObjectSchema;

// 6. A `default` inside an object array's item properties.
const refused6 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // @ts-expect-error -- an object-array item's properties take no `default`
        properties: { flag: { type: "boolean", default: false } },
      },
    },
  },
} as const satisfies ObjectSchema;
const valid6 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { flag: { type: "boolean" } },
      },
    },
  },
} as const satisfies ObjectSchema;

// 7. A string with `anyOf`.
const refused7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- a typed string takes no `anyOf`
    bad: { type: "string", anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const satisfies ObjectSchema;
const valid7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const satisfies ObjectSchema;

// 8. An integer with `anyOf`.
const refused8 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- a typed integer takes no `anyOf`
    bad: { type: "integer", anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const satisfies ObjectSchema;
const valid8 = {
  type: "object",
  additionalProperties: false,
  properties: { ok, bad: { type: "integer", minimum: 0 } },
} as const satisfies ObjectSchema;

// 9a. `oneOf` at a nested property.
const refused9a = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      // @ts-expect-error -- `oneOf` is not a supported keyword
      properties: { x: { oneOf: [{ type: "string" }, { type: "null" }] } },
    },
  },
} as const satisfies ObjectSchema;
const valid9a = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } },
    },
  },
} as const satisfies ObjectSchema;

// 9b. `format` on a nested string.
const refused9b = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      // @ts-expect-error -- `format` is not a supported keyword
      properties: { at: { type: "string", format: "date-time" } },
    },
  },
} as const satisfies ObjectSchema;
const valid9b = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { at: { type: "string", pattern: "^\\d{4}-" } },
    },
  },
} as const satisfies ObjectSchema;

// 9c. `minLength` on a string array's item.
const refused9c = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    // @ts-expect-error -- a string item takes no `minLength`
    bad: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const satisfies ObjectSchema;
const valid9c = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: { type: "array", items: { type: "string", enum: ["a"] } },
  },
} as const satisfies ObjectSchema;

// 10. Fixtures 3, 5 and 7 as plain `as const` variables assigned later, the
// way local tools declare their schemas: no excess-property check applies.
const structural3 = {
  type: "object",
  additionalProperties: false,
  properties: { ok, bad: { type: "object", required: ["x"] } },
} as const;
// @ts-expect-error -- structural: `required` without `properties`
const refused10a: ObjectSchema = structural3;
const structural5 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { flag: { type: "boolean", default: true } },
    },
  },
} as const;
// @ts-expect-error -- structural: a nested boolean `default`
const refused10b: ObjectSchema = structural5;
const structural7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: { type: "string", anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;
// @ts-expect-error -- structural: a typed string with `anyOf`
const refused10c: ObjectSchema = structural7;
const structuralValid3 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    },
  },
} as const;
const valid10a: ObjectSchema = structuralValid3;
const structuralValid5 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: {
      type: "object",
      additionalProperties: false,
      properties: { flag: { type: "boolean" } },
    },
  },
} as const;
const valid10b: ObjectSchema = structuralValid5;
const structuralValid7 = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok,
    bad: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;
const valid10c: ObjectSchema = structuralValid7;

const VALID_COUNTERPARTS: readonly ObjectSchema[] = [
  valid1,
  valid2,
  valid3,
  valid4,
  valid5a,
  valid5b,
  valid6,
  valid7,
  valid8,
  valid9a,
  valid9b,
  valid9c,
  valid10a,
  valid10b,
  valid10c,
];

void [
  refused1,
  refused2,
  refused3,
  refused4,
  refused5a,
  refused5b,
  refused6,
  refused7,
  refused8,
  refused9a,
  refused9b,
  refused9c,
  refused10a,
  refused10b,
  refused10c,
];
