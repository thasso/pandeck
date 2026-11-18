import assert from "node:assert/strict";
import { test } from "vitest";
import { isLeaseShaped } from "../gateway/leases.ts";
import { GATEWAY_REFUSAL_MARKER } from "../gateway/refusals.ts";
import {
  classifyClientCredential,
  hasClientCookie,
  MACHINE_PLACEHOLDER,
} from "./credentialClass.ts";
import {
  observationPath,
  RELAY_REFUSAL_MARKER,
  stripReservedHeaders,
} from "./modelTraffic.ts";

const lease = `a.${Buffer.from(JSON.stringify({ pandeck: { v: 1, lease: "fake_lease" } })).toString("base64url")}.c`;
const fixtures = [
  { headers: [], expected: "none" },
  {
    headers: ["Authorization", `Bearer ${MACHINE_PLACEHOLDER}`],
    expected: "placeholder",
  },
  { headers: ["x-api-key", MACHINE_PLACEHOLDER], expected: "placeholder" },
  { headers: ["Proxy-Authorization", `bearer ${lease}`], expected: "lease" },
  {
    headers: [
      "x-api-key",
      lease,
      "Authorization",
      `Bearer ${MACHINE_PLACEHOLDER}`,
    ],
    expected: "lease",
  },
  {
    headers: [
      "authorization",
      `Bearer ${lease}`,
      "AUTHORIZATION",
      "Bearer other",
    ],
    expected: "other",
  },
  {
    headers: ["authorization", "", "x-api-key", MACHINE_PLACEHOLDER],
    expected: "other",
  },
  { headers: ["proxy-authorization", "Basic fake"], expected: "other" },
  { headers: ["authorization", "Bearer a.b.c"], expected: "other" },
  { headers: ["authorization", "Bearer x y"], expected: "other" },
  { headers: ["x-api-key", ""], expected: "other" },
  { headers: ["authorization", ` Bearer   ${lease} `], expected: "lease" },
];

test("credential classes inspect all repeats and malformed values, never cookie content", () => {
  for (const { headers, expected } of fixtures)
    assert.equal(classifyClientCredential(headers), expected);
  assert.equal(hasClientCookie(["COOKIE", ""]), true);
  assert.equal(hasClientCookie(["authorization", "cookie"]), false);
});

test("local lease shape agrees with the gateway's parser at its format boundaries", () => {
  const payloads: unknown[] = [
    null,
    [],
    {},
    { pandeck: null },
    { pandeck: [] },
    { pandeck: { v: 1, lease: "x" } },
    { pandeck: { v: 1, lease: "x".repeat(64) } },
    { pandeck: { v: 1, lease: "x".repeat(65) } },
    { pandeck: { v: 1, lease: "" } },
    { pandeck: { v: "1", lease: "x" } },
    { pandeck: { v: 1, lease: "a.b" } },
  ];
  for (const payload of payloads) {
    const token = `a.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c`;
    assert.equal(
      classifyClientCredential(["x-api-key", token]),
      isLeaseShaped(token) ? "lease" : "other",
    );
  }
});

test("reserved headers are removed in any case with every repeat; marker is pinned", () => {
  assert.equal(RELAY_REFUSAL_MARKER, GATEWAY_REFUSAL_MARKER);
  assert.deepEqual(
    stripReservedHeaders([
      "Host",
      "localhost",
      "X-PanDeck-Relay-Id",
      "forged",
      "x-pandeck-other",
      "forged",
      "x-pandeck-other",
      "forged",
      "anthropic-beta",
      "a",
      "anthropic-beta",
      "b",
    ]),
    ["Host", "localhost", "anthropic-beta", "a", "anthropic-beta", "b"],
  );
  assert.equal(observationPath("/x\u0001/é?q=SENTINEL"), "/x%01/%C3%A9");
  assert.equal(observationPath("/" + "x".repeat(300)).length, 200);
  assert.equal(observationPath("http://SENTINEL/x?q=SENTINEL"), "/");
});
