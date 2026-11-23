/**
 * The `confluence_mutate_page` result contract (Task-1463 P6a, P6-F1), as
 * `jiraMutationResult.test.ts` is for Jira: the REAL shared prepare and
 * apply against the fake site (`test/confluenceMutateFetch.ts`) change
 * nothing but the contract's result fields, reach every one, and a record
 * merged onto the sent item rebuilds the applied one; then vetting, the
 * record check and the merge on hand-made items. Every value is fake.
 *
 * Not yet asserted here (M2): the effects ledger; every record carries
 * `possible` as a placeholder.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ConfluenceAttachmentMutationDisplay,
  ConfluencePageMutationItemDisplay,
} from "@assistant/shared/confluenceMutation";
import type { ConfluenceConfig } from "./atlassian/confluenceClient.ts";
import type { FrozenUpload } from "./confluenceAttachmentChange.ts";
import {
  MAX_MUTATION_ITEMS,
  buildConfluenceMutationItems,
  type ConfluenceMutateItemParams,
} from "./confluenceMutate.ts";
import { applyConfluenceMutationItems } from "./confluenceMutateApply.ts";
import { checkConfluencePageItems } from "./confluenceMutationCheck.ts";
import { ConfluenceMutationError } from "./confluenceMutationErrors.ts";
import {
  CONFLUENCE_RESULT_FIELDS,
  buildConfluenceResultRecord,
  checkConfluenceResult,
  confluenceProposalOf,
  mergeConfluenceResult,
  type ConfluenceResultRecord,
} from "./confluenceMutationResult.ts";
import { errorText } from "./errors.ts";
import { MAX_PROPOSAL_ITEMS } from "./mutationCheckRules.ts";
import {
  ERROR_FALLBACK,
  ITEM_ERROR_MAX,
  ITEM_WARNING_MAX,
} from "./mutationResultCodec.ts";
import {
  json,
  stubConfluenceWriteFetch,
  type SeenConfluenceWrite,
} from "./test/confluenceMutateFetch.ts";
import {
  REDACTED,
  SENTINEL,
  SITE,
  changedPaths,
  fakeVetting,
  wire,
} from "./test/mutationResultHarness.ts";

const config: ConfluenceConfig = {
  host: SITE,
  atlassianEmail: "me@x.test",
  atlassianToken: "FAKE-TOKEN",
};
const PAGES = `https://${SITE}/wiki/spaces/ENG/pages`;

afterEach(() => {
  vi.unstubAllGlobals();
});

const FROZEN: FrozenUpload = {
  name: "diagram.png",
  mimeType: "image/png",
  size: 3,
  sha256: "a".repeat(64),
  source: "/tmp/diagram.png",
  stagedAttachmentId: "staged-1",
};

interface RunOptions {
  /** Answers first; `applying` says whether prepare is done. */
  answer?: (
    request: SeenConfluenceWrite,
    applying: boolean,
  ) => Response | undefined;
  withStagedBytes?: boolean;
  stopBefore?: () => string | undefined;
}

/** Prepare and apply `input` against the fake site: the sent and applied items. */
async function run(
  input: ConfluenceMutateItemParams[],
  options: RunOptions = {},
): Promise<{
  sent: ConfluencePageMutationItemDisplay[];
  applied: ConfluencePageMutationItemDisplay[];
}> {
  let applying = false;
  stubConfluenceWriteFetch((request) => options.answer?.(request, applying));
  const prepared = await buildConfluenceMutationItems(config, input, {
    freezeUpload: async () => FROZEN,
  });
  const sent = wire(prepared.items);
  const applied = wire(sent);
  applying = true;
  try {
    await applyConfluenceMutationItems(config, applied, {
      describeError: errorText,
      ...(options.withStagedBytes
        ? { stagedBytes: async () => new Uint8Array([1, 2, 3]) }
        : {}),
      ...(options.stopBefore ? { stopBefore: options.stopBefore } : {}),
    });
  } catch (err) {
    if (!(err instanceof ConfluenceMutationError)) throw err;
  }
  return { sent, applied: wire(applied) };
}

const RESULT_PATHS = new Set<string>([
  ...CONFLUENCE_RESULT_FIELDS.item,
  ...CONFLUENCE_RESULT_FIELDS.attachment.map((key) => `attachment.${key}`),
]);

const reached = new Set<string>();

/** As `expectContract` in `jiraMutationResult.test.ts`; Confluence has no dual-use field. */
function expectContract(
  sent: ConfluencePageMutationItemDisplay[],
  applied: ConfluencePageMutationItemDisplay[],
): void {
  expect(checkConfluencePageItems(wire(sent))).toBe(true);
  for (const [index, item] of applied.entries()) {
    const before = sent[index]!;
    for (const path of changedPaths(before, item)) {
      reached.add(path);
      expect(RESULT_PATHS, path).toContain(path);
    }
    expect(confluenceProposalOf(item)).toEqual(before);
    const record = wire(
      buildConfluenceResultRecord(item, before, fakeVetting, "possible"),
    );
    expect(checkConfluenceResult(record, before, SITE)).toBe(true);
    const card = wire(before);
    mergeConfluenceResult(card, record);
    expect(card).toEqual(item);
  }
}

const CREATE: ConfluenceMutateItemParams = {
  operation: "create",
  spaceKey: "ENG",
  title: "New page",
  body: "Hello **there**.",
  addLabels: ["fresh"],
};
const APPEND: ConfluenceMutateItemParams = {
  operation: "edit",
  page: "123",
  body: "More.",
  placement: "append",
  addLabels: ["x"],
  removeLabels: ["y"],
};
const RENAME: ConfluenceMutateItemParams = {
  operation: "edit",
  page: "123",
  newTitle: "Renamed",
};
const COMMENT: ConfluenceMutateItemParams = {
  operation: "comment",
  page: "123",
  body: "Hi.",
};
const DELETE: ConfluenceMutateItemParams = { operation: "delete", page: "123" };
const DELETE_ATTACHMENT: ConfluenceMutateItemParams = {
  operation: "deleteAttachment",
  page: "123",
  attachmentId: "att1",
};
const UPLOAD: ConfluenceMutateItemParams = {
  operation: "uploadAttachment",
  page: "123",
  fileName: "diagram.png",
  sourcePath: "/tmp/diagram.png",
};

const isLabelWrite = (request: SeenConfluenceWrite) =>
  request.method !== "GET" && /\/label(?:\/|$)/.test(request.path);
const isUploadWrite = (request: SeenConfluenceWrite) =>
  request.method === "POST" && request.path.includes("/child/attachment");
const status400 = () => json({ message: "Bad request" }, 400);

describe("completeness: apply changes only the contract's result fields", () => {
  test("every operation succeeds", async () => {
    const { sent, applied } = await run(
      [CREATE, APPEND, RENAME, COMMENT, DELETE, DELETE_ATTACHMENT, UPLOAD],
      {
        withStagedBytes: true,
        answer: (request) =>
          isUploadWrite(request)
            ? json({ id: "att1", version: { number: 3 } })
            : undefined,
      },
    );
    expect(applied.map((item) => item.error)).toEqual(Array(7).fill(undefined));
    expect(applied[6]!.attachment).toMatchObject({
      resultId: "att1",
      resultVersion: 3,
    });
    expectContract(sent, applied);
  });

  test("failed label changes: a warning", async () => {
    const { sent, applied } = await run([CREATE, APPEND], {
      answer: (request) => (isLabelWrite(request) ? status400() : undefined),
    });
    expect(applied[1]!.warning).toMatch(/label changes failed/);
    expectContract(sent, applied);
  });

  test("an upload where apply has no staged bytes", async () => {
    const { sent, applied } = await run([UPLOAD, RENAME]);
    expect(applied[0]!.error).toMatch(/not available here/);
    expectContract(sent, applied);
  });

  test("a page whose version moved since the proposal", async () => {
    const { sent, applied } = await run([APPEND, RENAME], {
      answer: (request, applying) =>
        applying && request.method === "GET" && request.path.endsWith("/123")
          ? json({
              id: "123",
              title: "Page 123",
              status: "current",
              spaceId: "900",
              version: { number: 8 },
              body: { atlas_doc_format: { value: "{}" } },
              _links: { webui: "/spaces/ENG/pages/123" },
            })
          : undefined,
    });
    expect(applied.every((item) => item.error !== undefined)).toBe(true);
    expectContract(sent, applied);
  });

  test("a stop before the first item", async () => {
    const { sent, applied } = await run([CREATE, DELETE_ATTACHMENT], {
      stopBefore: () => "Stopped.",
    });
    expect(applied.map((item) => item.error)).toEqual(["Stopped.", "Stopped."]);
    expectContract(sent, applied);
  });

  test("every write fails", async () => {
    const { sent, applied } = await run([CREATE, APPEND, COMMENT, DELETE], {
      answer: (request, applying) =>
        applying && request.method !== "GET" ? status400() : undefined,
    });
    expect(applied.every((item) => item.error !== undefined)).toBe(true);
    expectContract(sent, applied);
  });

  test("the cases reach every result field", () => {
    expect([...reached].sort()).toEqual([...RESULT_PATHS].sort());
  });
});

test("one proposal cap for both products", () => {
  expect(MAX_PROPOSAL_ITEMS).toBe(MAX_MUTATION_ITEMS);
});

function item(
  overrides: Partial<ConfluencePageMutationItemDisplay> = {},
): ConfluencePageMutationItemDisplay {
  return {
    clientId: "cfl_0",
    operation: "edit",
    pageId: "123",
    pageUrl: `${PAGES}/123`,
    title: "Page 123",
    ...overrides,
  };
}

const attachment = (
  overrides: Partial<ConfluenceAttachmentMutationDisplay> = {},
): ConfluenceAttachmentMutationDisplay => ({
  fileName: "diagram.png",
  existingId: "att1",
  ...overrides,
});

const build = (
  applied: ConfluencePageMutationItemDisplay,
  sent: ConfluencePageMutationItemDisplay = confluenceProposalOf(applied),
) => buildConfluenceResultRecord(applied, sent, fakeVetting, "possible");

describe("buildConfluenceResultRecord vets every result on its raw value (C1)", () => {
  test("a written page id holding the secret is null and backs no link", () => {
    const created = item({
      operation: "create",
      resultPageId: `4${SENTINEL}`,
      resultPageUrl: `${PAGES}/4${SENTINEL}`,
    });
    delete created.pageId;
    expect(build(created)).toEqual({ effects: "possible", resultPageId: null });
  });

  test("a written but malformed page id never falls back to the sent one", () => {
    const record = build(
      item({ resultPageId: "12a", resultPageUrl: `${PAGES}/123` }),
    );
    expect(record).toEqual({ effects: "possible", resultPageId: null });
  });

  test("without a written page id the link is backed by the sent one", () => {
    expect(
      build(
        item({
          operation: "delete",
          resultPageId: null,
          resultPageUrl: `${PAGES}/123`,
        }),
      ),
    ).toEqual({
      effects: "possible",
      resultPageId: null,
      resultPageUrl: `${PAGES}/123`,
    });
    expect(
      build(item({ pageId: SENTINEL, resultPageUrl: `${PAGES}/${SENTINEL}` })),
    ).toEqual({ effects: "possible" });
  });

  test("a clean page answers its id, link and version; a bad version is left out", () => {
    expect(
      build(
        item({
          resultPageId: "123",
          resultPageUrl: `${PAGES}/123`,
          resultVersion: 8,
        }),
      ),
    ).toEqual({
      effects: "possible",
      resultPageId: "123",
      resultPageUrl: `${PAGES}/123`,
      resultVersion: 8,
    });
    for (const version of [-1, 1.5, 1_000_000_000])
      expect(build(item({ resultVersion: version })).resultVersion).toBe(
        undefined,
      );
    expect(build(item({ resultVersion: null })).resultVersion).toBeNull();
  });

  test("attachment results: present exactly when the sent item has an attachment", () => {
    expect(build(item()).attachment).toBeUndefined();
    expect(
      build(item({ operation: "uploadAttachment", attachment: attachment() }))
        .attachment,
    ).toEqual({});
    expect(
      build(
        item({
          operation: "uploadAttachment",
          attachment: attachment({ resultId: "att9", resultVersion: 3 }),
        }),
      ).attachment,
    ).toEqual({ resultId: "att9", resultVersion: 3 });
    expect(
      build(
        item({
          operation: "uploadAttachment",
          attachment: attachment({ resultId: `att${SENTINEL}` }),
        }),
      ).attachment,
    ).toEqual({});
    expect(
      build(
        item({
          operation: "uploadAttachment",
          attachment: attachment({ resultId: null, resultVersion: null }),
        }),
      ).attachment,
    ).toEqual({ resultId: null, resultVersion: null });
  });

  test("texts are redacted and capped: warning 400, error 600", () => {
    const record = build(
      item({
        warning: `${SENTINEL}${"w".repeat(500)}`,
        error: "e".repeat(700),
      }),
    );
    expect(record.warning).toBe(
      `${REDACTED}${"w".repeat(500)}`.slice(0, ITEM_WARNING_MAX),
    );
    expect(record.error).toBe("e".repeat(ITEM_ERROR_MAX));
    expect(build(item({ error: "" })).error).toBe(ERROR_FALLBACK);
  });
});

describe("checkConfluenceResult refuses what the edge must never send", () => {
  const sent = item({
    operation: "uploadAttachment",
    attachment: attachment(),
  });
  const valid: ConfluenceResultRecord = {
    effects: "possible",
    resultPageId: "123",
    resultPageUrl: `${PAGES}/123`,
    attachment: { resultId: "att1", resultVersion: 3 },
  };

  test("a valid record passes", () => {
    expect(checkConfluenceResult(valid, sent, SITE)).toBe(true);
  });

  test.each<[string, unknown, ConfluencePageMutationItemDisplay?]>([
    ["no effects", { ...valid, effects: undefined }],
    ["an unknown key", { ...valid, pageId: "123" }],
    ["a malformed page id", { ...valid, resultPageId: "12a" }],
    ["a link off the site", { ...valid, resultPageUrl: "https://x.test/123" }],
    ["a version over the cap", { ...valid, resultVersion: 1_000_000_000 }],
    ["a warning over 400", { ...valid, warning: "w".repeat(401) }],
    ["an error over 600", { ...valid, error: "e".repeat(601) }],
    ["attachment results missing", { ...valid, attachment: undefined }],
    [
      "a malformed attachment id",
      { ...valid, attachment: { resultId: "att-1" } },
    ],
    ["an unknown attachment key", { ...valid, attachment: { fileName: "x" } }],
    ["attachment results the item lacks", valid, item()],
  ])("%s", (_name, record, against = sent) => {
    expect(checkConfluenceResult(record, against, SITE)).toBe(false);
  });
});

test("mergeConfluenceResult deletes the previous run's absent results", () => {
  const card = item({
    operation: "uploadAttachment",
    attachment: attachment({ resultId: "att1", resultVersion: 2 }),
    resultPageId: "123",
    resultPageUrl: `${PAGES}/123`,
    resultVersion: 4,
    warning: "old",
    error: "old",
  });
  mergeConfluenceResult(card, {
    effects: "none",
    error: "Stopped.",
    attachment: {},
  });
  expect(card).toEqual(
    item({
      operation: "uploadAttachment",
      attachment: attachment(),
      error: "Stopped.",
    }),
  );
});
