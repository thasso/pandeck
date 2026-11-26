/**
 * The client-mode file tool's own checks (Task-1441 P7a, H3), over a stub
 * port: the gate before and after the call, E from the listing and the
 * call's limit argument, each refusal's fixed text, and the Confluence
 * adapter's exact file text (G4 step 6, R6b). Nothing refused is staged.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { updateConfluenceSettings } from "../../confluenceSettings.ts";
import {
  RemoteToolRefusal,
  acceptRemoteTools,
  applyListing,
  installRemoteToolPort,
  markDisconnected,
  type RemoteFileAnswer,
} from "../../remoteTools.ts";
import { listSessionAttachments } from "../../sessionAttachments.ts";
import { CONFLUENCE_DOWNLOAD_URL_MAX_CHARS } from "../../confluenceDownload.ts";
import { FILE_ADAPTERS, effectiveFileBytes } from "./remoteFiles.ts";
import {
  DISABLED,
  FILE_BUSY_HERE,
  FILE_CORRUPTED,
  NO_TOOLS,
  UNEXPECTED_FILE_ANSWER,
  UNREACHABLE,
} from "./remoteReadRules.ts";
import { remoteToolsFor } from "./remoteToolGroup.ts";

const MiB = 1024 * 1024;
const NAME = "confluence_download_attachment";

const listed = (file: Record<string, unknown> = {}) => ({
  name: NAME,
  description: "ignored",
  inputSchema: { type: "object" },
  effect: "read",
  actionKey: "confluence:read",
  file: {
    limitParam: "maxBytes",
    defaultBytes: 50 * MiB,
    maxBytes: 100 * MiB,
    ...file,
  },
});

const FIELDS = {
  status: "saved_attachment",
  pageId: "123",
  attachment: {
    id: "att1",
    title: "a.txt",
    mediaType: null,
    fileSize: 5,
    version: 3,
    downloadUrl: "https://example.atlassian.net/wiki/download/a.txt",
  },
};

const fileAnswer = (text: unknown = FIELDS): RemoteFileAnswer => ({
  kind: "file",
  text: typeof text === "string" ? text : JSON.stringify(text),
  file: { name: "a.txt", mimeType: "", size: 5, sha256: "0".repeat(64) },
  bytes: new TextEncoder().encode("hello"),
});

interface Seen {
  maxBytes: number;
  args: Record<string, unknown>;
}
let seen: Seen[] = [];
let respond: (use: (answer: RemoteFileAnswer) => unknown) => Promise<unknown>;
let uninstall = () => {};

beforeEach(() => {
  seen = [];
  respond = (use) => Promise.resolve(use(fileAnswer()));
  uninstall = installRemoteToolPort({
    call: () => Promise.reject(new Error("unused")),
    prepare: () => Promise.reject(new Error("unused")),
    apply: () => Promise.reject(new Error("unused")),
    uploads: {
      open: () => Promise.reject(new Error("unused")),
      put: () => Promise.reject(new Error("unused")),
      release: () => {},
    },
    callFile: (_name, args, _signal, expect, use) => {
      seen.push({ maxBytes: expect.maxBytes, args });
      return respond(use as never) as never;
    },
  });
  applyListing(acceptRemoteTools([listed()]));
  updateConfluenceSettings({ enabled: true });
});

afterEach(() => {
  updateConfluenceSettings({ enabled: false });
  uninstall();
});

const tool = () => {
  const found = remoteToolsFor("confluence").find((t) => t.name === NAME);
  assert.ok(found);
  return found;
};

let sessions = 0;
const run = async (args: Record<string, unknown>, signal?: AbortSignal) => {
  const sessionId = `p7a-files-${sessions++}`;
  const attempt = tool().execute(args, {
    session: { sessionId },
    ...(signal ? { signal } : {}),
  } as never);
  return { attempt, staged: () => listSessionAttachments(sessionId) };
};

test("a file answer is staged once and answered in the local tool's shape", async () => {
  const { attempt, staged } = await run({ attachmentId: "att1" });
  const result = await attempt;
  const [record] = staged();
  assert.ok(record);
  assert.equal(staged().length, 1);
  assert.equal(record.mimeType, "text/plain");
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(
    text,
    JSON.stringify(
      {
        ...FIELDS,
        sessionAttachment: {
          id: record.id,
          name: record.name,
          mimeType: record.mimeType,
          size: record.size,
          path: record.path,
        },
      },
      null,
      2,
    ),
  );
});

test("E is the listing's maxBytes and the call's maxBytes, clamped and truncated as the local tool's", () => {
  const limits = {
    limitParam: "maxBytes",
    defaultBytes: 50 * MiB,
    maxBytes: 100 * MiB,
  };
  const cases: Array<[unknown, number]> = [
    [undefined, 50 * MiB],
    [Number.NaN, 50 * MiB],
    [Number.POSITIVE_INFINITY, 50 * MiB],
    ["1024", 50 * MiB],
    [0, 1],
    [-5, 1],
    [1.9, 1],
    [4096.7, 4096],
    [200 * MiB, 100 * MiB],
  ];
  for (const [asked, expected] of cases)
    assert.equal(
      effectiveFileBytes(
        NAME,
        limits,
        asked === undefined ? {} : { maxBytes: asked },
      ),
      expected,
      String(asked),
    );
  // A smaller listing cap wins; another argument is not the limit.
  assert.equal(
    effectiveFileBytes(NAME, { ...limits, maxBytes: 10 }, { maxBytes: 50 }),
    10,
  );
  assert.equal(
    effectiveFileBytes(NAME, limits, { maxDownloadBytes: 5 }),
    50 * MiB,
  );
});

test("the call carries E and the agent's arguments", async () => {
  applyListing(acceptRemoteTools([listed({ maxBytes: 64, defaultBytes: 32 })]));
  await (
    await run({ attachmentId: "att1" })
  ).attempt;
  await (
    await run({ attachmentId: "att1", maxBytes: 1000 })
  ).attempt;
  assert.deepEqual(seen, [
    { maxBytes: 32, args: { attachmentId: "att1" } },
    { maxBytes: 64, args: { attachmentId: "att1", maxBytes: 1000 } },
  ]);
});

test("the gate before the call: off, unlisted or disconnected sends nothing", async () => {
  updateConfluenceSettings({ enabled: false });
  await assert.rejects((await run({})).attempt, {
    message: DISABLED.confluence,
  });
  updateConfluenceSettings({ enabled: true });
  const captured = tool();
  applyListing(acceptRemoteTools([]));
  await assert.rejects(
    captured.execute({}, { session: { sessionId: "p7a-unlisted" } } as never),
    { message: `The gateway no longer offers ${NAME}.` },
  );
  applyListing(acceptRemoteTools([listed()]));
  markDisconnected();
  await assert.rejects(
    captured.execute({}, { session: { sessionId: "p7a-gone" } } as never),
    { message: UNREACHABLE },
  );
  assert.deepEqual(seen, []);
});

test("the gate on the answer: Confluence turned off, the tool relisted with other limits, or the caller gone stages nothing", async () => {
  const cases: Array<[() => void, string, AbortController?]> = [
    [() => updateConfluenceSettings({ enabled: false }), DISABLED.confluence],
    [
      () => applyListing(acceptRemoteTools([listed({ maxBytes: 99 * MiB })])),
      `The gateway no longer offers ${NAME}.`,
    ],
    [
      () => applyListing(acceptRemoteTools([])),
      `The gateway no longer offers ${NAME}.`,
    ],
  ];
  for (const [change, message] of cases) {
    applyListing(acceptRemoteTools([listed()]));
    updateConfluenceSettings({ enabled: true });
    respond = (use) => {
      change();
      return Promise.resolve(use(fileAnswer()));
    };
    const { attempt, staged } = await run({});
    await assert.rejects(attempt, { message });
    assert.deepEqual(staged(), [], message);
  }
  // The abort fence: the caller left after the answer was decoded.
  applyListing(acceptRemoteTools([listed()]));
  updateConfluenceSettings({ enabled: true });
  const caller = new AbortController();
  respond = (use) => {
    caller.abort();
    return Promise.resolve(use(fileAnswer()));
  };
  const { attempt, staged } = await run({}, caller.signal);
  await assert.rejects(attempt, { message: "The call was cancelled." });
  assert.deepEqual(staged(), []);
});

test("each link refusal is this server's fixed text", async () => {
  const cases: Array<[string, string]> = [
    ["file_busy", FILE_BUSY_HERE],
    ["corrupted_file", FILE_CORRUPTED],
    ["unexpected_file", UNEXPECTED_FILE_ANSWER],
    ["tools_unavailable", NO_TOOLS],
    ["gateway_unavailable", UNREACHABLE],
  ];
  for (const [code, message] of cases) {
    respond = () => Promise.reject(new RemoteToolRefusal(code as "file_busy"));
    await assert.rejects((await run({})).attempt, { message }, code);
  }
});

test("the edge's failure and a plain answer: the edge's text passes, a plain success is refused", async () => {
  respond = (use) =>
    Promise.resolve(
      use({ kind: "failure", code: "tool_error", message: "Edge words." }),
    );
  await assert.rejects((await run({})).attempt, { message: "Edge words." });
  respond = (use) =>
    Promise.resolve(use({ kind: "failure", code: "timeout", message: "" }));
  await assert.rejects((await run({})).attempt, {
    message: "The gateway tool timed out.",
  });
  respond = (use) => Promise.resolve(use({ kind: "plain", text: "{}" }));
  const { attempt, staged } = await run({});
  await assert.rejects(attempt, { message: UNEXPECTED_FILE_ANSWER });
  assert.deepEqual(staged(), []);
});

test("the Confluence file text is checked exactly: each extra, missing or out-of-bounds field refuses it", () => {
  const { validateFileText } = FILE_ADAPTERS[NAME].adapter;
  assert.deepEqual(validateFileText(JSON.stringify(FIELDS)), {
    pageId: FIELDS.pageId,
    attachment: FIELDS.attachment,
  });
  // Every nullable field may be null.
  assert.ok(
    validateFileText(
      JSON.stringify({
        ...FIELDS,
        pageId: null,
        attachment: {
          ...FIELDS.attachment,
          mediaType: null,
          fileSize: null,
          version: null,
          downloadUrl: null,
        },
      }),
    ),
  );
  const att = (patch: Record<string, unknown>) => ({
    ...FIELDS,
    attachment: { ...FIELDS.attachment, ...patch },
  });
  const refused: Array<[string, unknown]> = [
    ["not JSON", "{"],
    ["an array", [FIELDS]],
    ["an extra key", { ...FIELDS, extra: 1 }],
    ["no pageId", { status: FIELDS.status, attachment: FIELDS.attachment }],
    ["another status", { ...FIELDS, status: "saved" }],
    ["a long pageId", { ...FIELDS, pageId: "1".repeat(65) }],
    ["a numeric pageId", { ...FIELDS, pageId: 123 }],
    ["an attachment extra key", att({ extra: 1 })],
    ["a long id", att({ id: "a".repeat(65) })],
    ["a long title", att({ title: "t".repeat(1025) })],
    ["a long mediaType", att({ mediaType: "m".repeat(1025) })],
    ["a fractional fileSize (R6b)", att({ fileSize: 1.5 })],
    ["a negative fileSize", att({ fileSize: -1 })],
    ["a fractional version", att({ version: 2.5 })],
    [
      "an http downloadUrl",
      att({ downloadUrl: "http://example.atlassian.net/x" }),
    ],
    [
      "a downloadUrl one over the bound",
      att({
        downloadUrl: `https://${"u".repeat(CONFLUENCE_DOWNLOAD_URL_MAX_CHARS - 7)}`,
      }),
    ],
  ];
  for (const [label, value] of refused)
    assert.equal(
      validateFileText(
        typeof value === "string" ? value : JSON.stringify(value),
      ),
      undefined,
      label,
    );
  // The bounds themselves are inside.
  assert.ok(
    validateFileText(
      JSON.stringify({
        ...att({
          id: "a".repeat(64),
          title: "t".repeat(1024),
          downloadUrl: `https://${"u".repeat(CONFLUENCE_DOWNLOAD_URL_MAX_CHARS - 8)}`,
        }),
        pageId: "1".repeat(64),
      }),
    ),
  );
});
