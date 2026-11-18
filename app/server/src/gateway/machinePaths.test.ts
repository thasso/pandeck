/**
 * The token routes' machine rules (Task-1430 PR3, v03 C8): the method floor,
 * the canonical-path rule, the deny floor and the listed templates, as pure
 * functions of the route and method.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  classifyMachinePath,
  deniedBy,
  isCanonicalPath,
  listedTemplate,
  machinePathVerdict,
} from "./machinePaths.ts";
import { routeFor, type Route } from "./upstreams.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function route(url: string): Route {
  const found = routeFor(url);
  assert.ok(found, url);
  return found;
}

/** Each floor entry's id and a concrete root for it (`*` filled in). */
const FLOOR: readonly [string, string][] = [
  ["v1-oauth", "/v1/oauth"],
  ["oauth-token", "/api/oauth/token"],
  ["oauth-authorize", "/api/oauth/authorize"],
  ["oauth-revoke", "/api/oauth/revoke"],
  ["cli-create-api-key", "/api/oauth/claude_cli/create_api_key"],
  ["v1-org-api-keys", "/v1/organizations/api_keys"],
  ["v1-org-x-api-keys", `/v1/organizations/${UUID}/api_keys`],
  ["org-x-api-keys", `/api/organizations/${UUID}/api_keys`],
  ["v1-org-invites", "/v1/organizations/invites"],
  ["v1-org-users", "/v1/organizations/users"],
  ["v1-org-x-invites", `/v1/organizations/${UUID}/invites`],
  ["v1-org-x-users", `/v1/organizations/${UUID}/users`],
  ["org-x-invites", `/api/organizations/${UUID}/invites`],
  ["org-x-members", `/api/organizations/${UUID}/members`],
  ["api-auth", "/api/auth"],
];

/** `path` with the last segment's first letter percent-encoded. */
function encodeLastLetter(path: string): string {
  const cut = path.lastIndexOf("/") + 1;
  const letter = path.charCodeAt(cut).toString(16);
  return `${path.slice(0, cut)}%${letter}${path.slice(cut + 1)}`;
}

describe("the deny floor (C8)", () => {
  test("has fifteen entries", () => assert.equal(FLOOR.length, 15));

  for (const [id, root] of FLOOR)
    test(`${id}: the endpoint and below, never a sibling or disguise`, () => {
      const verdict = (path: string) =>
        machinePathVerdict(route(`/anthropic${path}`), "POST", "permissive");
      const denied = { case: "denied", id };
      const nonCanonical = { case: "non-canonical-path" };
      assert.deepEqual(verdict(root), denied, "root");
      assert.deepEqual(verdict(`${root}/x`), denied, "one descendant");
      assert.deepEqual(verdict(`${root}/x/y`), denied, "two descendants");
      assert.deepEqual(verdict(`${root}?x=1`), denied, "a query never matters");
      assert.deepEqual(verdict(root.toUpperCase()), denied, "case folded");
      assert.deepEqual(verdict(encodeLastLetter(root)), nonCanonical);
      assert.deepEqual(verdict(`${root}%2Fx`), nonCanonical, "%2F");
      assert.deepEqual(verdict(`${root}%252Fx`), nonCanonical, "%252F");
      assert.deepEqual(verdict(`${root}/./x`), nonCanonical, "/./");
      assert.deepEqual(verdict(`${root}/../x`), nonCanonical, "/../");
      assert.equal(verdict(`${root}_status`), undefined, "a sibling");
      assert.equal(verdict(`${root}2`), undefined, "a sibling");
      // The floor reads the full pathname, past what a record shows.
      const long = `${root}/${"d".repeat(220)}`;
      assert.ok(long.length > 200);
      assert.deepEqual(verdict(long), denied, "over 200 characters");
      if (root.includes(UUID)) {
        const deep = root.replace(UUID, "w".repeat(190));
        assert.ok(deep.lastIndexOf("/") > 200);
        assert.deepEqual(verdict(deep), denied, "segment past truncation");
      }
      // The same on the MCP host.
      assert.deepEqual(
        machinePathVerdict(route(`/anthropic-mcp${root}`), "GET", "strict"),
        denied,
      );
    });

  test("E1's account calls only share a prefix with an entry", () => {
    for (const path of [
      "/api/oauth/usage",
      "/api/oauth/validate",
      `/api/oauth/organizations/${UUID}/skills/list-skills`,
      "/api/oauth",
      "/v1/organizations",
    ])
      assert.equal(deniedBy(path), undefined, path);
  });
});

describe("the canonical-path rule", () => {
  test("refuses empty, dot and backslash segments and bad escapes", () => {
    for (const path of [
      "",
      "/",
      "//x",
      "/x//y",
      "/x/",
      "/./x",
      "/x/..",
      "/x\\y",
      "/x%zz",
      "/x%2",
      "/%7e",
      "/%7E",
      "/%41",
      "/%2e",
      "/%2F",
      "/%5C",
      "/%25",
    ])
      assert.equal(isCanonicalPath(path), false, path);
  });

  test("allows escapes of reserved and other bytes", () => {
    for (const path of ["/x", "/a%20b", "/a%3Ab", "/a%3ab", "/x@y", "/a/b.c"])
      assert.equal(isCanonicalPath(path), true, path);
  });
});

describe("the listed templates", () => {
  const EXAMPLES: readonly [string, string, string, string][] = [
    ["/anthropic", "POST", "/v1/messages", "/v1/messages"],
    [
      "/anthropic",
      "POST",
      "/v1/messages/count_tokens",
      "/v1/messages/count_tokens",
    ],
    ["/anthropic", "POST", "/api/oauth/validate", "/api/oauth/validate"],
    [
      "/anthropic",
      "GET",
      "/api/claude_cli/bootstrap",
      "/api/claude_cli/bootstrap",
    ],
    [
      "/anthropic",
      "POST",
      "/api/eval/sdk-zAZezfDKGoZuXXKe",
      "/api/eval/sdk-zAZezfDKGoZuXXKe",
    ],
    [
      "/anthropic",
      "GET",
      "/api/claude_code_penguin_mode",
      "/api/claude_code_penguin_mode",
    ],
    [
      "/anthropic",
      "GET",
      "/api/claude_code/policy_limits",
      "/api/claude_code/policy_limits",
    ],
    [
      "/anthropic",
      "GET",
      "/api/claude_code/settings",
      "/api/claude_code/settings",
    ],
    [
      "/anthropic",
      "GET",
      `/api/organizations/${UUID}/model_selector/cc`,
      "/api/organizations/:uuid/model_selector/cc",
    ],
    [
      "/anthropic",
      "GET",
      `/api/oauth/organizations/${UUID}/marketplaces`,
      "/api/oauth/organizations/:uuid/marketplaces",
    ],
    [
      "/anthropic",
      "GET",
      `/api/oauth/organizations/${UUID}/plugins/list-plugins`,
      "/api/oauth/organizations/:uuid/plugins/list-plugins",
    ],
    [
      "/anthropic",
      "GET",
      `/api/oauth/organizations/${UUID}/plugins/my.plugin_1-x/download`,
      "/api/oauth/organizations/:uuid/plugins/:slug/download",
    ],
    [
      "/anthropic",
      "GET",
      `/api/oauth/organizations/${UUID}/skills/list-skills`,
      "/api/oauth/organizations/:uuid/skills/list-skills",
    ],
    [
      "/anthropic",
      "GET",
      `/api/oauth/organizations/${UUID}/skills/pdf/download`,
      "/api/oauth/organizations/:uuid/skills/:slug/download",
    ],
    ["/anthropic", "GET", "/v1/mcp_servers", "/v1/mcp_servers"],
    ["/anthropic", "POST", "/api/artifacts/mcp", "/api/artifacts/mcp"],
    ["/anthropic", "GET", "/api/oauth/usage", "/api/oauth/usage"],
    [
      "/anthropic",
      "POST",
      "/api/event_logging/v2/batch",
      "/api/event_logging/v2/batch",
    ],
    [
      "/anthropic",
      "POST",
      "/api/claude_code/metrics",
      "/api/claude_code/metrics",
    ],
    [
      "/anthropic",
      "GET",
      "/api/directory/server-urls",
      "/api/directory/server-urls",
    ],
    ["/anthropic", "GET", "/api/web/domain_info", "/api/web/domain_info"],
    ["/anthropic-mcp", "POST", "/v1/mcp/linear", "/v1/mcp/:slug"],
  ];

  test("every template has an example, and marks it", () => {
    assert.equal(EXAMPLES.length, 22);
    for (const [prefix, method, path, template] of EXAMPLES) {
      assert.equal(listedTemplate(prefix, method, path), template, path);
      assert.deepEqual(
        classifyMachinePath(route(`${prefix}${path}?q=1`), method),
        { listed: true, pathKey: template },
      );
      assert.equal(
        machinePathVerdict(route(`${prefix}${path}`), method, "strict"),
        undefined,
      );
    }
  });

  test("anything else is unlisted, its pathname its key", () => {
    const unlisted = (prefix: string, method: string, path: string) =>
      assert.equal(listedTemplate(prefix, method, path), undefined, path);
    unlisted("/anthropic", "POST", "/api/eval/sdk-other");
    unlisted("/anthropic", "GET", "/api/eval/sdk-zAZezfDKGoZuXXKe");
    unlisted("/anthropic", "GET", "/api/oauth/validate");
    unlisted(
      "/anthropic",
      "GET",
      `/api/organizations/${UUID.toUpperCase()}/model_selector/cc`,
    );
    unlisted(
      "/anthropic",
      "GET",
      "/api/organizations/not-a-uuid/model_selector/cc",
    );
    unlisted("/anthropic-mcp", "POST", "/v1/mcp/..");
    unlisted("/anthropic-mcp", "POST", "/v1/mcp/.");
    unlisted("/anthropic-mcp", "POST", "/v1/mcp/%2e");
    unlisted("/anthropic-mcp", "POST", "/v1/mcp/a%20b");
    unlisted("/anthropic-mcp", "POST", `/v1/mcp/${"s".repeat(129)}`);
    assert.equal(
      listedTemplate("/anthropic-mcp", "POST", `/v1/mcp/${"s".repeat(128)}`),
      "/v1/mcp/:slug",
    );
    // Each route has its own templates.
    unlisted("/anthropic-mcp", "POST", "/v1/messages");
    unlisted("/anthropic", "POST", "/v1/mcp/linear");
    unlisted("/chatgpt", "POST", "/backend-api/codex/responses");
    assert.deepEqual(
      classifyMachinePath(route("/anthropic/api/new_thing?x=1"), "GET"),
      { listed: false, pathKey: "/api/new_thing" },
    );
  });
});

describe("the order of the rules", () => {
  test("the method floor first, then canonical, then the floor, then strict", () => {
    const usage = route("/anthropic/api/oauth/usage");
    for (const method of ["TRACE", "TRACK", "CONNECT"]) {
      assert.deepEqual(machinePathVerdict(usage, method, "permissive"), {
        case: "denied",
        id: "method",
      });
      assert.deepEqual(
        machinePathVerdict(route("/anthropic/api/auth"), method, "strict"),
        { case: "denied", id: "method" },
      );
      assert.deepEqual(classifyMachinePath(usage, method), {
        listed: false,
        pathKey: "/api/oauth/usage",
      });
    }
    assert.deepEqual(
      machinePathVerdict(route("/anthropic/api/auth/"), "POST", "permissive"),
      { case: "non-canonical-path" },
    );
    assert.deepEqual(
      classifyMachinePath(route("/anthropic/api/auth/"), "POST"),
      { listed: false, pathKey: "/api/auth/" },
    );
    assert.deepEqual(
      classifyMachinePath(route("/anthropic/api/auth"), "POST"),
      { listed: false, pathKey: "/api/auth" },
    );
    const unlisted = route("/anthropic-mcp/x");
    assert.equal(machinePathVerdict(unlisted, "PUT", "permissive"), undefined);
    assert.deepEqual(machinePathVerdict(unlisted, "PUT", "strict"), {
      case: "forbidden",
    });
  });
});
