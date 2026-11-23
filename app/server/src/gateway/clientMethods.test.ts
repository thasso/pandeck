/**
 * Gateway client 1.1 (Task-1463 P6a): the version and its compatibility,
 * the edge's `tools.prepare`/`tools.apply` request decoders and the client's
 * shallow answer decoders with their byte caps. The caps mirror the edge's
 * own; this pins them equal. Every value is fake.
 */
import { describe, expect, test } from "vitest";
import {
  PREPARE_ANSWER_MAX_BYTES as EDGE_PREPARE_MAX,
  RESULT_MAX_BYTES,
} from "../gatewayTools/twoPhase.ts";
import { WorkerMethodError } from "../workerProtocol/connection.ts";
import {
  APPLY_ANSWER_MAX_BYTES,
  CLIENT_METHODS,
  GATEWAY_CLIENT_PROTOCOL,
  GATEWAY_CLIENT_VERSION,
  PREPARE_ANSWER_MAX_BYTES,
  decodeApplyAnswer,
  decodePrepareAnswer,
  decodeToolApply,
  decodeToolPrepare,
} from "./clientMethods.ts";

function invalidParams(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WorkerMethodError);
  expect((thrown as WorkerMethodError).code).toBe("invalid_params");
}

describe("the version", () => {
  test("is 1.1; a 1.0 and a 1.1 peer are compatible, another major is not", () => {
    expect(GATEWAY_CLIENT_VERSION).toBe("gateway-client/1.1");
    const { compatible } = GATEWAY_CLIENT_PROTOCOL;
    expect(compatible("gateway-client/1.0")).toBe(true);
    expect(compatible("gateway-client/1.1")).toBe(true);
    expect(compatible("gateway-client/1.7")).toBe(true);
    expect(compatible("gateway-client/2.0")).toBe(false);
    expect(compatible("gateway-client/0.9")).toBe(false);
    expect(compatible("gateway-control/1.1")).toBe(false);
  });

  test("names both new methods", () => {
    expect([CLIENT_METHODS.toolsPrepare, CLIENT_METHODS.toolsApply]).toEqual([
      "tools.prepare",
      "tools.apply",
    ]);
  });
});

describe("the edge's request decoders", () => {
  test("tools.prepare reads as tools.call", () => {
    expect(
      decodeToolPrepare({
        json: { name: "jira_mutate_issue", args: { a: 1 } },
      }),
    ).toEqual({ name: "jira_mutate_issue", args: { a: 1 } });
    expect(decodeToolPrepare({ json: { name: "jira_mutate_issue" } })).toEqual({
      name: "jira_mutate_issue",
      args: {},
    });
    invalidParams(() => decodeToolPrepare({ json: { name: "Bad" } }));
    invalidParams(() =>
      decodeToolPrepare({ json: { name: "jira_mutate_issue", args: [] } }),
    );
  });

  test("tools.apply takes a name, a site of at most 253 characters and an items array, unchecked", () => {
    const items = [{ clientId: "jira_0" }, "anything"];
    expect(
      decodeToolApply({
        json: { name: "jira_mutate_issue", site: "a.atlassian.net", items },
      }),
    ).toEqual({
      name: "jira_mutate_issue",
      request: { site: "a.atlassian.net", items },
    });
    for (const json of [
      { site: "a", items: [] },
      { name: "x-y", site: "a", items: [] },
      { name: "jira_mutate_issue", items: [] },
      { name: "jira_mutate_issue", site: "", items: [] },
      { name: "jira_mutate_issue", site: "a".repeat(254), items: [] },
      { name: "jira_mutate_issue", site: 1, items: [] },
      { name: "jira_mutate_issue", site: "a" },
      { name: "jira_mutate_issue", site: "a", items: {} },
    ])
      invalidParams(() => decodeToolApply({ json }));
    expect(
      decodeToolApply({
        json: { name: "jira_mutate_issue", site: "a".repeat(253), items: [] },
      }).request.site,
    ).toHaveLength(253);
  });
});

describe("the client's answer decoders", () => {
  test("their caps are the edge's", () => {
    expect(APPLY_ANSWER_MAX_BYTES).toBe(RESULT_MAX_BYTES);
    expect(PREPARE_ANSWER_MAX_BYTES).toBe(EDGE_PREPARE_MAX);
  });

  test("a prepare answer: the proposal as sent, or a failure with a known code", () => {
    const proposal = {
      ok: true,
      site: "a.atlassian.net",
      items: [{ clientId: "jira_0" }],
      warnings: ["w"],
    };
    expect(decodePrepareAnswer({ json: proposal })).toEqual(proposal);
    expect(
      decodePrepareAnswer({
        json: { ok: false, code: "weird", message: "x".repeat(600) },
      }),
    ).toEqual({ ok: false, code: "failed", message: "x".repeat(500) });
    for (const json of [
      { ...proposal, ok: "yes" },
      { ...proposal, site: 1 },
      { ...proposal, items: "x" },
      { ...proposal, items: [1] },
      { ...proposal, items: Array.from({ length: 11 }, () => ({})) },
      { ...proposal, warnings: [1] },
      { ...proposal, warnings: Array.from({ length: 11 }, () => "w") },
      { ...proposal, warnings: undefined },
      null,
    ])
      expect(() => decodePrepareAnswer({ json })).toThrow(/malformed/);
  });

  test("an apply answer: the records as sent, or a failure whose effects read possible unless none", () => {
    const results = [{ effects: "possible", resultIssueKey: "STAR-1" }];
    const unwritten = [{ effects: "none", error: "Not applied" }];
    for (const json of [
      { ok: true, results, effects: "possible" },
      { ok: true, results: unwritten, effects: "none", trimmed: true },
    ])
      expect(decodeApplyAnswer({ json })).toEqual(json);
    expect(
      decodeApplyAnswer({
        json: {
          ok: false,
          code: "timeout",
          message: "late",
          effects: "possible",
          itemEffects: ["possible", "none", "bogus"],
        },
      }),
    ).toEqual({
      ok: false,
      code: "timeout",
      message: "late",
      effects: "possible",
      itemEffects: ["possible", "none", "possible"],
    });
    expect(
      decodeApplyAnswer({ json: { ok: false, code: "failed", message: "x" } }),
    ).toEqual({ ok: false, code: "failed", message: "x", effects: "possible" });
    expect(
      decodeApplyAnswer({
        json: { ok: false, code: "invalid_params", effects: "none" },
      }),
    ).toEqual({
      ok: false,
      code: "invalid_params",
      message: "",
      effects: "none",
    });
    for (const json of [
      { ok: true, results, effects: "maybe" },
      { ok: true, results },
      // The root never says none beside a possible record (v03).
      { ok: true, results, effects: "none" },
      { ok: true, results, effects: "none", trimmed: false },
      { ok: true, results: [1], effects: "none" },
      {
        ok: true,
        results: Array.from({ length: 11 }, () => ({})),
        effects: "none",
      },
      { ok: "true", results, effects: "none" },
      "text",
    ])
      expect(() => decodeApplyAnswer({ json })).toThrow(/malformed/);
  });

  test("a failure after the apply started: its records, trimmed and item effects, when well formed", () => {
    const results = [
      { effects: "possible", resultIssueKey: "STAR-200" },
      { effects: "possible", error: "interrupted" },
    ];
    const failure = {
      ok: false,
      code: "timeout",
      message: "late",
      effects: "possible",
      itemEffects: ["possible", "possible"],
    };
    expect(decodeApplyAnswer({ json: { ...failure, results } })).toEqual({
      ...failure,
      results,
    });
    expect(
      decodeApplyAnswer({ json: { ...failure, results, trimmed: true } }),
    ).toEqual({ ...failure, results, trimmed: true });
    // Records that are not records are left out; the failure stays.
    for (const bad of ["x", [1], Array.from({ length: 11 }, () => ({}))])
      expect(
        decodeApplyAnswer({
          json: { ...failure, results: bad, trimmed: true },
        }),
      ).toEqual(failure);
    // A root none beside a possible record or item is undecodable.
    for (const json of [
      { ...failure, effects: "none", results },
      { ...failure, effects: "none", itemEffects: ["none", "possible"] },
      { ...failure, effects: "none", itemEffects: ["bogus"] },
    ])
      expect(() => decodeApplyAnswer({ json })).toThrow(/effects disagree/);
    expect(
      decodeApplyAnswer({
        json: {
          ...failure,
          effects: "none",
          itemEffects: ["none"],
          results: [{ effects: "none" }],
        },
      }),
    ).toMatchObject({ effects: "none", results: [{ effects: "none" }] });
  });

  test("an answer over its cap is refused, whatever its shape", () => {
    const over = (max: number, base: object) => {
      const bytes = Buffer.byteLength(JSON.stringify({ ...base, pad: "" }));
      return { ...base, pad: "a".repeat(max - bytes + 1) };
    };
    expect(() =>
      decodeApplyAnswer({
        json: over(APPLY_ANSWER_MAX_BYTES, {
          ok: true,
          results: [],
          effects: "none",
        }),
      }),
    ).toThrow(/over its size/);
    expect(() =>
      decodePrepareAnswer({
        json: over(PREPARE_ANSWER_MAX_BYTES, {
          ok: false,
          code: "failed",
          message: "x",
        }),
      }),
    ).toThrow(/over its size/);
  });
});
