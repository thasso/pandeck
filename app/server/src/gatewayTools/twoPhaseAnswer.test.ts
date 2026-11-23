/**
 * The two-phase answers' rules (Task-1463 P6a) without a fake site: the
 * effects ledger, the check of the apply answer as sent and its degraded
 * forms, the final byte guards, the worst-case reply bound (P6-F3), the edge
 * vetting and the marker-free secret check. Every value is fake.
 */
import { describe, expect, test } from "vitest";
import type { ConfluencePageMutationItemDisplay } from "@assistant/shared/confluenceMutation";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { checkConfluenceResult } from "../confluenceMutationResult.ts";
import { decodeApplyAnswer } from "../gateway/clientMethods.ts";
import { jsonBytes } from "../mutationCheckRules.ts";
import {
  checkJiraResult,
  shrinkJiraResults,
  type JiraResultRecord,
} from "../jiraMutationResult.ts";
import {
  ERROR_FALLBACK,
  WARNING_FALLBACK,
  type Effects,
} from "../mutationResultCodec.ts";
import { assertNoCredential } from "../test/credentialOracle.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import { confluenceOutcomeOf } from "./confluenceMutatePage.ts";
import type { ApplyContext, AtlassianTokenCredential } from "./descriptor.ts";
import { createToolHost } from "./host.ts";
import { jiraMutateIssue, jiraOutcomeOf } from "./jiraMutateIssue.ts";
import { vettingFor } from "./mutationResultVetting.ts";
import {
  INTERRUPTED,
  PREPARE_ANSWER_MAX_BYTES,
  PROPOSAL_INVALID,
  PROPOSAL_TOO_LARGE,
  PROPOSAL_WITHHELD,
  RESULT_MAX_BYTES,
  RESULT_TOO_LARGE,
  RESULT_WITHHELD,
  STOPPED,
  applyAnswerWithinCap,
  createWriteLedger,
  prepareAnswerWithinCap,
  runApply,
  runPrepare,
  type ApplyAnswer,
  type ApplyProduct,
  type PrepareProduct,
} from "./twoPhase.ts";
import { carriesSecret, holdsSecret } from "./upstreamText.ts";

const FAKE: AtlassianTokenCredential = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const SITE_URL = `https://${FAKE.site}/browse/STAR-1`;
/** A token JSON escaping changes, with no 16-character piece it leaves alone. */
const QUOTED: AtlassianTokenCredential = { ...FAKE, token: 'ABC"DEF\\GHI' };

describe("the effects ledger", () => {
  test("marks the current item before its write; a write outside an item marks the root alone", () => {
    const ledger = createWriteLedger();
    expect([ledger.root(), ledger.items()]).toEqual(["none", undefined]);
    ledger.hooks.beforeWrite();
    ledger.begin(3);
    expect(ledger.root()).toBe("possible");
    expect(ledger.items()).toEqual(["none", "none", "none"]);
    ledger.hooks.startItem(0);
    ledger.hooks.startItem(1);
    ledger.hooks.beforeWrite();
    ledger.hooks.beforeWrite();
    ledger.hooks.startItem(2);
    expect(ledger.items()).toEqual(["none", "possible", "none"]);
    expect([0, 1, 2].map((index) => ledger.item(index))).toEqual([
      "none",
      "possible",
      "none",
    ]);
    // A copy: the caller cannot change the ledger.
    ledger.items()![0] = "possible";
    expect(ledger.item(0)).toBe("none");
  });

  test("an apply that never wrote leaves every effect none", () => {
    const ledger = createWriteLedger();
    ledger.begin(2);
    ledger.hooks.startItem(0);
    ledger.hooks.startItem(1);
    expect([ledger.root(), ledger.items()]).toEqual(["none", ["none", "none"]]);
  });
});

interface FakeItem {
  clientId: string;
  error?: string;
}
interface FakeRecord {
  effects: Effects;
  text?: string;
  error?: string;
}

/**
 * A product whose apply writes for each item but the second, and whose
 * records carry `text`; `outcome` is its degraded record.
 */
function fakeProduct(options: {
  text: (index: number) => string;
  outcome?: (record: FakeRecord) => FakeRecord;
  shrink?: ApplyProduct<null, FakeItem, FakeRecord>["shrink"];
  writeOutside?: boolean;
  /** The item whose write is followed by an unexpected exception. */
  throwAt?: number;
}): ApplyProduct<null, FakeItem, FakeRecord> {
  return {
    configOf: () => null,
    isAllFailed: (_err): _err is Error => false,
    check: (items): items is FakeItem[] => Array.isArray(items),
    apply(_config, _credential, items, deps) {
      if (options.writeOutside) deps.beforeWrite();
      items.forEach((_item, index) => {
        deps.startItem(index);
        if (deps.stopBefore() === undefined && index !== 1) deps.beforeWrite();
        if (index === options.throwAt) {
          deps.beforeWrite();
          throw new Error("unexpected");
        }
      });
      return Promise.resolve();
    },
    vetting: vettingFor,
    record: (applied, _sent, _vet, effects) => ({
      effects,
      text: options.text(Number(applied.clientId)),
      ...(applied.error !== undefined ? { error: applied.error } : {}),
    }),
    shrink: options.shrink ?? (() => false),
    outcomeOf: options.outcome ?? (({ effects }) => ({ effects })),
  };
}

function context(credential = FAKE): ApplyContext {
  return {
    credential: () => Promise.resolve(credential),
    signal: new AbortController().signal,
    cancel: new AbortController().signal,
    deadlineAt: Date.now() + 45_000,
    ledger: createWriteLedger(),
  };
}

const THREE = {
  site: FAKE.site,
  items: [0, 1, 2].map(String).map((clientId) => ({ clientId })),
};

/** A product whose prepare builds `items` and whose check is `valid`. */
function fakePrepare(
  items: FakeItem[],
  valid = true,
): PrepareProduct<null, FakeItem> {
  return {
    nothingWritten: " Nothing was written.",
    prepareRefusalFallback: "The fake could not prepare.",
    configOf: () => null,
    describeError: () => "The fake failed.",
    prepare: () => Promise.resolve({ items, warnings: [] }),
    check: (value): value is FakeItem[] => valid && Array.isArray(value),
  };
}

describe("the prepare answer as sent", () => {
  const ctx = {
    credential: () => Promise.resolve(FAKE),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
  };

  test("items its own check refuses are an edge fault, never sent", async () => {
    await expect(
      runPrepare(ctx, fakePrepare([{ clientId: "0" }], false)),
    ).rejects.toMatchObject({ message: PROPOSAL_INVALID, code: "tool_error" });
  });

  test("items carrying credential material are withheld whole: the token, a piece of it, the Basic pair", async () => {
    for (const clientId of [
      `x ${FAKE.token} y`,
      `x ${FAKE.token.slice(3, 22)} y`,
      `x ${Buffer.from(`${FAKE.email}:${FAKE.token}`).toString("base64")} y`,
    ])
      await expect(
        runPrepare(ctx, fakePrepare([{ clientId }])),
      ).rejects.toMatchObject({ message: PROPOSAL_WITHHELD });
    // An ordinary body naming auth schemes is not a secret.
    await expect(
      runPrepare(
        ctx,
        fakePrepare([{ clientId: "Authorization: Basic is how we log in" }]),
      ),
    ).resolves.toEqual({
      site: FAKE.site,
      items: [{ clientId: "Authorization: Basic is how we log in" }],
      warnings: [],
    });
  });
});

test("F003: a proposal string or key holding a token JSON escaping changes is withheld whole", async () => {
  const ctx = {
    credential: () => Promise.resolve(QUOTED),
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 30_000,
  };
  for (const item of [
    { clientId: QUOTED.token },
    { clientId: "0", nested: [{ deep: `x ${QUOTED.token} y` }] },
    { clientId: "0", [QUOTED.token]: true },
  ]) {
    // The serialized answer holds only the escaped token.
    expect(JSON.stringify(item)).not.toContain(QUOTED.token);
    await expect(
      runPrepare(ctx, fakePrepare([item as FakeItem])),
    ).rejects.toMatchObject({ message: PROPOSAL_WITHHELD });
  }
});

describe("the apply answer as sent", () => {
  test("F003: a record string holding a token JSON escaping changes degrades", async () => {
    const answer = await runApply(
      context(QUOTED),
      fakeProduct({ text: () => `x ${QUOTED.token} y` }),
      THREE,
    );
    expect(answer).toEqual({
      ok: true,
      effects: "possible",
      trimmed: true,
      results: [
        { effects: "possible" },
        { effects: "none" },
        { effects: "possible" },
      ],
    });
    assertNoCredential(JSON.stringify(answer), QUOTED);
  });

  test("clean records are sent whole, each with its ledger effects", async () => {
    const answer = await runApply(
      context(),
      fakeProduct({ text: (index) => `row ${index}` }),
      THREE,
    );
    expect(answer).toEqual({
      ok: true,
      effects: "possible",
      results: [
        { effects: "possible", text: "row 0" },
        { effects: "none", text: "row 1" },
        { effects: "possible", text: "row 2" },
      ],
    });
  });

  test("records that would carry a secret form degrade, keeping every effects entry", async () => {
    const answer = await runApply(
      context(),
      fakeProduct({ text: () => FAKE.token }),
      THREE,
    );
    expect(answer).toEqual({
      ok: true,
      effects: "possible",
      trimmed: true,
      results: [
        { effects: "possible" },
        { effects: "none" },
        { effects: "possible" },
      ],
    });
    expect(applyAnswerWithinCap(answer, () => {})).toBe(answer);
    assertNoCredential(JSON.stringify(answer), FAKE);
  });

  test("when even the degraded records would, a fixed failure keeps each item's effects in order", async () => {
    const answer = await runApply(
      context(),
      fakeProduct({ text: () => FAKE.token, outcome: (record) => record }),
      THREE,
    );
    expect(answer).toEqual({
      ok: false,
      code: "failed",
      message: RESULT_WITHHELD,
      effects: "possible",
      itemEffects: ["possible", "none", "possible"],
    });
    expect(applyAnswerWithinCap(answer, () => {})).toBe(answer);
  });

  test("a write outside every item makes the root possible", async () => {
    const answer = await runApply(
      { ...context(), cancel: AbortSignal.abort() },
      fakeProduct({ text: () => "x", writeOutside: true }),
      THREE,
    );
    expect(answer).toMatchObject({
      ok: true,
      effects: "possible",
      results: [{ effects: "none" }, { effects: "none" }, { effects: "none" }],
    });
  });

  test("the shrink runs only while the answer is over RESULT_MAX_BYTES, and says trimmed", async () => {
    const shrink: ApplyProduct<null, FakeItem, FakeRecord>["shrink"] = (
      records,
      fits,
    ) => {
      if (fits()) return false;
      for (const record of records) record.text = "cut";
      return true;
    };
    const big = await runApply(
      context(),
      fakeProduct({ text: () => "x".repeat(200_000), shrink }),
      THREE,
    );
    expect(big).toMatchObject({ ok: true, trimmed: true });
    expect((big as { results: FakeRecord[] }).results[0]!.text).toBe("cut");
    const small = await runApply(
      context(),
      fakeProduct({ text: () => "x".repeat(100_000), shrink }),
      THREE,
    );
    expect(small).not.toHaveProperty("trimmed");
  });
});

describe("F006: an answer within RESULT_MAX_BYTES is never shrunk", () => {
  /**
   * The success answer, or the failure projection (item 1 throws), whose
   * first record's text makes it `bytes` long; `stages` counts the shrink
   * stages run, each of which cuts nothing.
   */
  async function sized(bytes: number, failure: boolean) {
    let stages = 0;
    const run = async (pad: number) => {
      const ledger = createWriteLedger();
      const product = fakeProduct({
        text: (index) => (index === 0 ? "x".repeat(pad) : ""),
        shrink: (_records, fits) => {
          if (fits()) return false;
          stages += 1;
          return true;
        },
        ...(failure ? { throwAt: 1 } : {}),
      });
      if (!failure) return runApply({ ...context(), ledger }, product, THREE);
      await expect(
        runApply({ ...context(), ledger }, product, THREE),
      ).rejects.toThrow("unexpected");
      return ledger.failed({ ok: false, code: "timeout", message: "late" });
    };
    const base = jsonBytes(await run(0))!;
    stages = 0;
    const answer = await run(bytes - base);
    return { answer, stages };
  }

  for (const failure of [false, true])
    test(`${failure ? "the failure projection" : "a success"}: at the cap minus one and at the cap, as is through the client decoder; one over, trimmed then guarded`, async () => {
      for (const bytes of [RESULT_MAX_BYTES - 1, RESULT_MAX_BYTES]) {
        const { answer, stages } = await sized(bytes, failure);
        expect(jsonBytes(answer)).toBe(bytes);
        expect(stages).toBe(0);
        expect(answer).not.toHaveProperty("trimmed");
        expect(answer).toMatchObject(
          failure ? { ok: false, code: "timeout" } : { ok: true },
        );
        expect(applyAnswerWithinCap(answer, () => {})).toBe(answer);
        expect(decodeApplyAnswer({ json: answer })).toEqual(answer);
      }
      const { answer, stages } = await sized(RESULT_MAX_BYTES + 1, failure);
      expect(stages).toBe(1);
      expect(answer).toMatchObject({ trimmed: true });
      expect(applyAnswerWithinCap(answer, () => {})).toEqual({
        ok: false,
        code: "failed",
        message: RESULT_TOO_LARGE,
        effects: "possible",
        itemEffects: failure
          ? ["possible", "possible", "none"]
          : ["possible", "none", "possible"],
      });
    });
});

/** A success answer whose serialized form is exactly `bytes` long. */
function answerOfBytes(bytes: number): ApplyAnswer {
  const answer = {
    ok: true as const,
    results: [{ effects: "possible" as const, text: "" }],
    effects: "possible" as const,
  };
  const pad = bytes - jsonBytes(answer)!;
  // Each "é" is two UTF-8 bytes; an odd remainder takes one "a".
  answer.results[0]!.text =
    "é".repeat(Math.floor(pad / 2)) + "a".repeat(pad % 2);
  return answer;
}

describe("F004: a failure after the apply started keeps its records", () => {
  /** The real host, whose Jira apply runs `product` instead. */
  const hostWith = (product: ApplyProduct<null, FakeItem, FakeRecord>) =>
    createToolHost(
      [
        {
          ...jiraMutateIssue,
          phases: {
            ...jiraMutateIssue.phases!,
            apply: (request, ctx) => runApply(ctx, product, request),
          },
        },
      ],
      { log: () => {} },
    );
  const caller = {
    clientId: "client-1",
    credential: () =>
      Promise.resolve({
        ok: true as const,
        credential: encodeAtlassianCredential(FAKE),
      }),
  };

  test("an unexpected exception mid-batch: finished items as left, the one running interrupted, the rest not started", async () => {
    const answer = await hostWith(
      fakeProduct({ text: (index) => `row ${index}`, throwAt: 1 }),
    ).apply("jira_mutate_issue", THREE, caller);
    expect(answer).toMatchObject({
      ok: false,
      code: "failed",
      effects: "possible",
      itemEffects: ["possible", "possible", "none"],
      results: [
        { effects: "possible", text: "row 0" },
        { effects: "possible", text: "row 1", error: INTERRUPTED },
        { effects: "none", text: "row 2", error: STOPPED },
      ],
    });
  });

  test("the projection's records go through the same check: a secret degrades them, code and message kept", async () => {
    const ledger = createWriteLedger();
    await expect(
      runApply(
        { ...context(), ledger },
        fakeProduct({ text: () => FAKE.token, throwAt: 0 }),
        THREE,
      ),
    ).rejects.toThrow("unexpected");
    const answer = ledger.failed({
      ok: false,
      code: "timeout",
      message: "late",
    });
    expect(answer).toEqual({
      ok: false,
      code: "timeout",
      message: "late",
      effects: "possible",
      itemEffects: ["possible", "none", "none"],
      trimmed: true,
      results: [
        { effects: "possible" },
        { effects: "none" },
        { effects: "none" },
      ],
    });
    assertNoCredential(JSON.stringify(answer), FAKE);
  });

  test("before the apply began, or should the projection throw, the effects alone", () => {
    const ledger = createWriteLedger();
    const failure = {
      ok: false as const,
      code: "failed" as const,
      message: "x",
    };
    expect(ledger.failed(failure)).toEqual({ ...failure, effects: "none" });
    ledger.begin(2);
    ledger.hooks.startItem(0);
    ledger.hooks.beforeWrite();
    ledger.project(() => {
      throw new Error("projection");
    });
    expect(ledger.failed(failure)).toEqual({
      ...failure,
      effects: "possible",
      itemEffects: ["possible", "none"],
    });
  });

  test("an over-cap failure with records drops them, keeping its effects", () => {
    const failure: ApplyAnswer = {
      ok: false,
      code: "timeout",
      message: "late",
      effects: "possible",
      itemEffects: ["possible", "none"],
      results: [
        { effects: "possible", text: "x".repeat(RESULT_MAX_BYTES) },
        { effects: "none" },
      ] as FakeRecord[],
    };
    expect(applyAnswerWithinCap(failure, () => {})).toEqual({
      ok: false,
      code: "failed",
      message: RESULT_TOO_LARGE,
      effects: "possible",
      itemEffects: ["possible", "none"],
    });
  });
});

describe("the final byte guards", () => {
  test("an apply answer at the cap leaves as it is; one byte over becomes RESULT_TOO_LARGE with its effects", () => {
    let over = 0;
    const atCap = answerOfBytes(RESULT_MAX_BYTES);
    expect(jsonBytes(atCap)).toBe(RESULT_MAX_BYTES);
    expect(applyAnswerWithinCap(atCap, () => (over += 1))).toBe(atCap);
    const overCap = answerOfBytes(RESULT_MAX_BYTES + 1);
    expect(applyAnswerWithinCap(overCap, () => (over += 1))).toEqual({
      ok: false,
      code: "failed",
      message: RESULT_TOO_LARGE,
      effects: "possible",
      itemEffects: ["possible"],
    });
    expect(over).toBe(1);
  });

  test("an over-cap failure keeps its itemEffects exactly", () => {
    const failure: ApplyAnswer = {
      ok: false,
      code: "failed",
      message: "x".repeat(RESULT_MAX_BYTES),
      effects: "possible",
      itemEffects: ["none", "possible", "none"],
    };
    expect(applyAnswerWithinCap(failure, () => {})).toEqual({
      ok: false,
      code: "failed",
      message: RESULT_TOO_LARGE,
      effects: "possible",
      itemEffects: ["none", "possible", "none"],
    });
  });

  test("a prepare answer over its cap becomes PROPOSAL_TOO_LARGE", () => {
    const fits = {
      ok: true as const,
      site: FAKE.site,
      items: [{ text: "x".repeat(1_000) }],
      warnings: [],
    };
    expect(prepareAnswerWithinCap(fits)).toBe(fits);
    expect(
      prepareAnswerWithinCap({
        ...fits,
        items: [{ text: "x".repeat(PREPARE_ANSWER_MAX_BYTES) }],
      }),
    ).toEqual({ ok: false, code: "tool_error", message: PROPOSAL_TOO_LARGE });
  });
});

/**
 * P6-F3's table: each capped text at 6 bytes per code unit, the longest
 * keys, link and sprint name, and 20,972 nested entries, every one with an
 * error. The bound holds after the three shrink stages.
 */
describe("the worst-case reply bound", () => {
  const ESCAPED = "\u0001";
  const KEY = `A${"B".repeat(54)}-12345678`;
  const NESTED_TOTAL = 20_972;

  function worstRecords(): JiraResultRecord[] {
    return Array.from({ length: 10 }, (_, item) => {
      const count =
        Math.floor(NESTED_TOTAL / 10) + (item < NESTED_TOTAL % 10 ? 1 : 0);
      const half = Math.floor(count / 2);
      const nested = (length: number) => ({
        ok: "0".repeat(length),
        errors: Array.from({ length }, (_e, index): [number, string] => [
          index + 10_000,
          ESCAPED.repeat(300),
        ]),
      });
      return {
        effects: "possible",
        resultIssueKey: KEY,
        createdIssueKey: KEY,
        resultIssueUrl: `https://${FAKE.site}/${"u".repeat(300 - FAKE.site.length - 9)}`,
        warning: ESCAPED.repeat(400),
        error: ESCAPED.repeat(600),
        rankResultOrder: Array.from({ length: 1_000 }, () => KEY),
        linkChanges: nested(half),
        rankSteps: nested(count - half),
        sprintResult: {
          name: ESCAPED.repeat(255),
          startDate: "2026-11-23T09:00:00.000000000+00:00",
          endDate: "2026-12-04T17:00:00.000000000+00:00",
        },
      };
    });
  }

  test("each item record without its nested results is within 10,240 bytes", () => {
    for (const record of worstRecords()) {
      const {
        linkChanges: _l,
        rankSteps: _r,
        rankResultOrder: _o,
        ...item
      } = record;
      expect(jsonBytes(item)).toBeLessThanOrEqual(10_240);
    }
  });

  test("after stage 3 the whole answer is within 418,004 bytes, under RESULT_MAX_BYTES", () => {
    const records = worstRecords();
    expect(
      jsonBytes({ ok: true, results: records, effects: "possible" }),
    ).toBeGreaterThan(RESULT_MAX_BYTES);
    const trimmed = shrinkJiraResults(records, () => false, vettingFor(FAKE));
    expect(trimmed).toBe(true);
    const answer = {
      ok: true,
      results: records,
      effects: "possible",
      trimmed: true,
    };
    const bytes = jsonBytes(answer)!;
    expect(bytes).toBeLessThanOrEqual(418_004);
    expect(bytes).toBeLessThan(RESULT_MAX_BYTES);
    expect(
      records.every((record) => record.rankResultOrder === undefined),
    ).toBe(true);
  });
});

describe("the degraded records", () => {
  // Only the nested arrays' lengths matter to the alignment check.
  const SENT_JIRA = {
    clientId: "jira_0",
    issueKey: "STAR-1",
    linkChanges: [{}, {}],
  } as unknown as JiraIssueMutationItemDisplay;

  test("a Jira record keeps effects, nested outcomes and which texts were present", () => {
    const record: JiraResultRecord = {
      effects: "possible",
      resultIssueKey: "STAR-1",
      resultIssueUrl: SITE_URL,
      warning: "w",
      error: "e",
      rankResultOrder: ["STAR-1"],
      linkChanges: { ok: "10", errors: [[1, "bad"]] },
    };
    const outcome = jiraOutcomeOf(record);
    expect(outcome).toEqual({
      effects: "possible",
      resultIssueKey: null,
      warning: WARNING_FALLBACK,
      error: ERROR_FALLBACK,
      linkChanges: { ok: "10", errors: [[1, ""]] },
    });
    expect(checkJiraResult(outcome, SENT_JIRA, FAKE.site)).toBe(true);
    expect(jiraOutcomeOf({ effects: "none" })).toEqual({ effects: "none" });
  });

  test("a Confluence record keeps effects, versions and its attachment's presence", () => {
    const sent = {
      clientId: "cfl_0",
      operation: "deleteAttachment",
      attachment: { fileName: "a.png" },
    } as ConfluencePageMutationItemDisplay;
    const outcome = confluenceOutcomeOf({
      effects: "possible",
      resultPageId: "123",
      resultPageUrl: `https://${FAKE.site}/wiki/spaces/ENG/pages/123`,
      resultVersion: 8,
      error: "e",
      attachment: { resultId: "att1", resultVersion: 2 },
    });
    expect(outcome).toEqual({
      effects: "possible",
      resultPageId: null,
      resultVersion: 8,
      error: ERROR_FALLBACK,
      attachment: { resultId: null, resultVersion: 2 },
    });
    expect(checkConfluenceResult(outcome, sent, FAKE.site)).toBe(true);
  });
});

describe("the edge vetting", () => {
  const vet = vettingFor({ ...FAKE, token: "TOKENKEY-123456" });

  test("an identifier holding the secret is refused before its format", () => {
    expect(vet.identifier("TOKENKEY-123456", "jiraKey")).toBeUndefined();
    expect(vet.identifier("STAR-12", "jiraKey")).toBe("STAR-12");
    expect(vet.identifier("star-12", "jiraKey")).toBeUndefined();
    expect(vet.identifier("att1", "attachmentId")).toBe("att1");
    expect(vet.identifier(12, "pageId")).toBeUndefined();
  });

  test("a link holding the secret raw, once or twice encoded, or without a backing, is left out", () => {
    const base = `https://${FAKE.site}/browse/`;
    const once = encodeURIComponent("TOKENKEY-123456").replace(/-/g, "%2D");
    const twice = encodeURIComponent(once);
    expect(vet.url(`${base}STAR-1`, "STAR-1")).toBe(`${base}STAR-1`);
    expect(vet.url(`${base}TOKENKEY-123456`, "STAR-1")).toBeUndefined();
    expect(vet.url(`${base}${once}`, "STAR-1")).toBeUndefined();
    expect(vet.url(`${base}${twice}`, "STAR-1")).toBeUndefined();
    expect(vet.url(`${base}STAR-1`, undefined)).toBeUndefined();
    expect(
      vet.url("https://other.atlassian.net/browse/STAR-1", "STAR-1"),
    ).toBeUndefined();
  });

  test("a text is redacted and capped, an empty one is its fallback", () => {
    expect(vet.text("key TOKENKEY-123456 here", 100, "f")).toBe(
      "key [redacted] here",
    );
    expect(vet.text("abcdef", 4, "f")).toHaveLength(4);
  });
});

test("carriesSecret counts secret forms and their pieces, not auth markers", () => {
  const text = "A basic setup; Authorization is described below.";
  expect(holdsSecret(text, FAKE)).toBe(true);
  expect(carriesSecret(text, FAKE)).toBe(false);
  expect(carriesSecret(`x ${FAKE.token.slice(2, 20)} y`, FAKE)).toBe(true);
  expect(
    carriesSecret(
      Buffer.from(`${FAKE.email}:${FAKE.token}`).toString("base64"),
      FAKE,
    ),
  ).toBe(true);
});
