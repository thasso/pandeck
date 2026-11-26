/**
 * The host's upload seams (Task-1441 P8a, v09 P1, v10 S1/S2): declared
 * sources reach prepare only as a host option, apply consumes the
 * connection's upload synchronously before its timer and only with an output
 * seam (P4), the deadline grows with the bytes (N1), the execution hold is
 * the tool's own promise, and Confluence's apply uploads exactly the
 * consumed bytes. Every value is fake.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  stubConfluenceWriteFetch,
  type SeenConfluenceWrite,
} from "../test/confluenceMutateFetch.ts";
import { assertNoCredential } from "../test/credentialOracle.ts";
import { encodeAtlassianCredential } from "./atlassian.ts";
import {
  MCP_UPLOAD_UNAVAILABLE,
  UPLOAD_UNAVAILABLE,
  confluenceDeleteSwitchFor,
} from "./confluenceMutatePage.ts";
import type {
  ApplyContext,
  AtlassianToolDescriptor,
  PrepareContext,
} from "./descriptor.ts";
import {
  FILE_BUSY,
  createFileBudget,
  createToolHost,
  type ToolCaller,
} from "./host.ts";
import { createEdgeTools } from "./index.ts";
import { edgeTools } from "./tools.ts";
import { ITEMS_INVALID, type ApplyAnswer } from "./twoPhase.ts";
import {
  UPLOAD_BUSY,
  UPLOAD_EXPIRED,
  UPLOAD_MISMATCH,
  UPLOAD_SOURCE_MISSING,
  type UploadEntry,
  type UploadScope,
} from "./uploads.ts";

const FAKE = {
  site: "acme.atlassian.net",
  email: "me@x.test",
  token: "FAKE-TOKEN-SENTINEL-0123456789",
};
const MIB = 1024 * 1024;
const CONFLUENCE = "confluence_mutate_page";
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * A client caller: counted credential reads, and an output seam whose
 * registered holds run when the test settles the answer's output.
 */
function client(options: { onSettled?: false } = {}) {
  const holds: (() => void)[] = [];
  let reads = 0;
  const caller: ToolCaller = {
    clientId: "client-1",
    credential: () => {
      reads += 1;
      return Promise.resolve({
        ok: true as const,
        credential: encodeAtlassianCredential(FAKE),
      });
    },
    ...(options.onSettled === false
      ? {}
      : { onSettled: (fn: () => void) => void holds.push(fn) }),
  };
  return {
    caller,
    reads: () => reads,
    holds: () => holds.length,
    settleOutput: () => holds.splice(0).forEach((fn) => fn()),
  };
}

/** A fake scope whose `consume` answers `consumed` and is counted. */
function fakeScope(
  consumed: ReturnType<UploadScope["consume"]>,
): UploadScope & { consumed: number } {
  const scope = {
    consumed: 0,
    open: () => {
      throw new Error("not used");
    },
    put: () => {
      throw new Error("not used");
    },
    release: () => ({ ok: true as const }),
    invalid: () => ({
      ok: false as const,
      code: "tool_error" as const,
      message: "",
    }),
    end: () => {},
    consume: () => {
      scope.consumed += 1;
      return consumed;
    },
  };
  return scope;
}

function attachedScope(work: number) {
  const events: string[] = [];
  const scope = fakeScope({
    ok: true,
    upload: {
      work,
      stagedBytes: () => Promise.resolve(new Uint8Array(0)),
      executionSettled: () => events.push("execution"),
    },
    outputSettled: () => events.push("output"),
  });
  return { scope, events };
}

/** A two-phase fixture tool whose apply the test drives. */
function fixture(apply: (ctx: ApplyContext) => Promise<ApplyAnswer>) {
  const seen: { prepare?: PrepareContext; apply?: ApplyContext } = {};
  const tool: AtlassianToolDescriptor = {
    name: "fixture_write",
    description: "A two-phase fixture.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "write",
    actionKey: "fixture:write",
    integration: "atlassian",
    deadlineMs: 45_000,
    execute: () => Promise.reject(new Error("not on /mcp")),
    phases: {
      prepare: (_params, ctx) => {
        seen.prepare = ctx;
        return Promise.resolve({ site: FAKE.site, items: [], warnings: [] });
      },
      apply: (_request, ctx) => {
        seen.apply = ctx;
        return apply(ctx);
      },
    },
  };
  return { host: createToolHost([tool], { log: () => {} }), seen };
}

const OK: ApplyAnswer = { ok: true, results: [], effects: "none" };
const REQUEST = { site: FAKE.site, items: [] };

describe("apply's upload option", () => {
  test.each([
    [1, 46_000],
    [MIB, 46_000],
    [MIB + 1, 47_000],
    [50 * MIB, 95_000],
    [100 * MIB, 145_000],
  ])("W = %d bytes arms the deadline at %d ms", async (work, ms) => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { host, seen } = fixture(() => Promise.resolve(OK));
    const { scope } = attachedScope(work);
    await host.apply("fixture_write", REQUEST, client().caller, {
      upload: { id: "upl-1", scope },
    });
    expect(seen.apply!.deadlineAt - 1_000_000).toBe(ms);
    expect(seen.apply!.upload?.work).toBe(work);
  });

  test("without an upload, the tool's own deadline and no upload context", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { host, seen } = fixture(() => Promise.resolve(OK));
    await host.apply("fixture_write", REQUEST, client().caller);
    expect(seen.apply!.deadlineAt - 1_000_000).toBe(45_000);
    expect(seen.apply!.upload).toBeUndefined();
  });

  test("P4: no output seam refuses before consumption, effects none", async () => {
    const { host, seen } = fixture(() => Promise.resolve(OK));
    const { scope } = attachedScope(1);
    const who = client({ onSettled: false });
    expect(
      await host.apply("fixture_write", REQUEST, who.caller, {
        upload: { id: "upl-1", scope },
      }),
    ).toEqual({
      ok: false,
      code: "invalid_params",
      message: ITEMS_INVALID,
      effects: "none",
    });
    expect(scope.consumed).toBe(0);
    expect(seen.apply).toBeUndefined();
    expect(who.reads()).toBe(0);
  });

  test("an unknown tool name never consumes the upload", async () => {
    const { host } = fixture(() => Promise.resolve(OK));
    const { scope } = attachedScope(1);
    const answer = await host.apply("no_such_tool", REQUEST, client().caller, {
      upload: { id: "upl-1", scope },
    });
    expect(answer).toMatchObject({ ok: false, code: "unknown_tool" });
    expect(scope.consumed).toBe(0);
  });

  test("a refused consumption answers its text with effects none and registers its release", async () => {
    let released = 0;
    const scope = fakeScope({
      ok: false,
      message: UPLOAD_EXPIRED,
      outputSettled: () => (released += 1),
    });
    const { host, seen } = fixture(() => Promise.resolve(OK));
    const who = client();
    expect(
      await host.apply("fixture_write", REQUEST, who.caller, {
        upload: { id: "upl-1", scope },
      }),
    ).toEqual({
      ok: false,
      code: "invalid_params",
      message: UPLOAD_EXPIRED,
      effects: "none",
    });
    expect(seen.apply).toBeUndefined();
    expect(who.reads()).toBe(0);
    expect(released).toBe(0);
    who.settleOutput();
    expect(released).toBe(1);
  });

  test("the execution hold waits for the tool's own promise, past the deadline", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const { host } = fixture(
      () => new Promise<ApplyAnswer>((resolve) => (finish = () => resolve(OK))),
    );
    const { scope, events } = attachedScope(1);
    const who = client();
    const answer = host.apply("fixture_write", REQUEST, who.caller, {
      upload: { id: "upl-1", scope },
    });
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await answer).toMatchObject({ ok: false, code: "timeout" });
    who.settleOutput();
    expect(events).toEqual(["output"]);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["output", "execution"]);
  });

  test("a plain apply registers no output hold", async () => {
    const { host } = fixture(() => Promise.resolve(OK));
    const who = client();
    await host.apply("fixture_write", REQUEST, who.caller);
    expect(who.holds()).toBe(0);
  });
});

describe("prepare's upload option", () => {
  test("reaches the tool as a map by id; absent, there is none", async () => {
    const { host, seen } = fixture(() => Promise.resolve(OK));
    const entry: UploadEntry = {
      stagedAttachmentId: "s1",
      name: "a.png",
      mimeType: "image/png",
      size: 3,
      sha256: "a".repeat(64),
      source: "a.png",
    };
    const first = await host.prepare("fixture_write", {}, client().caller, {
      uploads: [entry],
    });
    expect(first).toMatchObject({ ok: true });
    expect([...seen.prepare!.uploads!]).toEqual([["s1", entry]]);
    await host.prepare("fixture_write", {}, client().caller);
    expect(seen.prepare!.uploads).toBeUndefined();
  });
});

// --- Confluence end to end through the store ---

const SOURCE = new TextEncoder().encode("PNG-BYTES-0123456789");
const ENTRY: UploadEntry = {
  stagedAttachmentId: "stage-1",
  name: "chart.png",
  mimeType: "image/png",
  size: SOURCE.byteLength,
  sha256: sha(SOURCE),
  source: "/home/me/chart.png",
};
const UPLOAD = {
  operation: "uploadAttachment",
  page: "123",
  sourceAttachmentId: "stage-1",
};
const EDIT = { page: "123", body: "Added" };

function edge(capacity?: number) {
  const fileBudget = createFileBudget(capacity);
  const set = createEdgeTools({
    log: () => {},
    atlassianScopes: [],
    fileBudget,
  });
  return { ...set, fileBudget };
}

async function prepared(set: ReturnType<typeof edge>, items: unknown[]) {
  const answer = await set.host.prepare(
    CONFLUENCE,
    { items },
    client().caller,
    {
      uploads: [ENTRY],
    },
  );
  if (!answer.ok) throw new Error(answer.message);
  return answer;
}

function sealedUpload(
  scope: UploadScope,
  bytes = SOURCE,
  work = bytes.byteLength,
) {
  const opened = scope.open({
    streams: [
      {
        stagedAttachmentId: ENTRY.stagedAttachmentId,
        size: bytes.byteLength,
        sha256: sha(bytes),
      },
    ],
    work,
  });
  if (!opened.ok) throw new Error(opened.message);
  const put = scope.put(
    {
      uploadId: opened.uploadId,
      stagedAttachmentId: ENTRY.stagedAttachmentId,
      offset: 0,
    },
    bytes,
  );
  expect(put).toMatchObject({ ok: true, sealed: true });
  return opened.uploadId;
}

const writesOf = (seen: SeenConfluenceWrite[]) =>
  seen.filter((request) => request.method !== "GET");

describe("confluence_mutate_page with a client's upload", () => {
  test("prepare freezes the declared source: nothing is read and the card keeps its text", async () => {
    const seen = stubConfluenceWriteFetch();
    const proposal = await prepared(edge(), [UPLOAD]);
    expect(proposal.items).toMatchObject([
      {
        operation: "uploadAttachment",
        attachment: {
          fileName: "chart.png",
          mediaType: "image/png",
          size: ENTRY.size,
          sha256: ENTRY.sha256,
          source: ENTRY.source,
          stagedAttachmentId: "stage-1",
        },
      },
    ]);
    expect(writesOf(seen)).toEqual([]);
  });

  test.each<[string, unknown[], readonly UploadEntry[] | undefined, string]>([
    ["no declared sources", [UPLOAD], undefined, UPLOAD_UNAVAILABLE],
    [
      "a sourcePath beside declared sources",
      [{ ...UPLOAD, sourcePath: "/etc/passwd" }],
      [ENTRY],
      UPLOAD_SOURCE_MISSING,
    ],
    [
      "an undeclared source",
      [{ ...UPLOAD, sourceAttachmentId: "other" }],
      [ENTRY],
      UPLOAD_SOURCE_MISSING,
    ],
    ["a declared source no item names", [EDIT], [ENTRY], UPLOAD_SOURCE_MISSING],
    [
      "W over 100 MiB",
      [UPLOAD, UPLOAD],
      [{ ...ENTRY, size: 60 * MIB }],
      UPLOAD_SOURCE_MISSING,
    ],
  ])(
    "prepare with %s refuses before the credential, sending nothing",
    async (_what, items, uploads, message) => {
      const seen = stubConfluenceWriteFetch();
      const who = client();
      const answer = await edge().host.prepare(
        CONFLUENCE,
        { items },
        who.caller,
        uploads ? { uploads } : {},
      );
      expect(answer).toEqual({ ok: false, code: "tool_error", message });
      // Client mode keeps P5b's text, never `/mcp`'s (P7b v07 R1).
      expect(answer.ok ? "" : answer.message).not.toBe(MCP_UPLOAD_UNAVAILABLE);
      expect(who.reads()).toBe(0);
      expect(seen).toEqual([]);
    },
  );

  test("`uploads` as an argument is not a seam: the schema refuses it", async () => {
    stubConfluenceWriteFetch();
    const answer = await edge().host.prepare(
      CONFLUENCE,
      { items: [UPLOAD], uploads: [ENTRY] },
      client().caller,
    );
    expect(answer).toMatchObject({ ok: false, code: "invalid_params" });
  });

  test("apply uploads exactly the consumed bytes and releases the permit after both holds", async () => {
    const set = edge();
    stubConfluenceWriteFetch();
    const proposal = await prepared(set, [EDIT, UPLOAD]);
    vi.unstubAllGlobals();
    const scope = set.uploads.scope("user-1");
    const uploadId = sealedUpload(scope);
    const seen = stubConfluenceWriteFetch();
    const who = client();
    const answer = await set.host.apply(
      CONFLUENCE,
      { site: proposal.site, items: proposal.items },
      who.caller,
      { upload: { id: uploadId, scope } },
    );
    expect(answer).toMatchObject({ ok: true, effects: "possible" });
    const uploads = seen.filter((request) => request.upload);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.upload!.text).toBe(new TextDecoder().decode(SOURCE));
    expect(uploads[0]!.upload!.fileName).toBe("chart.png");
    assertNoCredential(JSON.stringify(answer), FAKE);
    // Execution has settled; the output has not: the permit stays held.
    expect(set.fileBudget.reserved).toBeGreaterThan(0);
    expect(
      scope.open({
        streams: [{ stagedAttachmentId: "x", size: 1, sha256: "a".repeat(64) }],
        work: 1,
      }),
    ).toMatchObject({ message: UPLOAD_BUSY });
    who.settleOutput();
    expect(set.fileBudget.reserved).toBe(0);
    // Consumed once: the same id again is refused, effects none.
    expect(
      await set.host.apply(
        CONFLUENCE,
        { site: proposal.site, items: proposal.items },
        client().caller,
        { upload: { id: uploadId, scope } },
      ),
    ).toMatchObject({ ok: false, message: ITEMS_INVALID, effects: "none" });
  });

  test("apply with upload items but no upload refuses whole, sending nothing", async () => {
    const set = edge();
    stubConfluenceWriteFetch();
    const proposal = await prepared(set, [EDIT, UPLOAD]);
    vi.unstubAllGlobals();
    const seen = stubConfluenceWriteFetch();
    const who = client();
    const answer = await set.host.apply(
      CONFLUENCE,
      { site: proposal.site, items: proposal.items },
      who.caller,
    );
    expect(answer).toMatchObject({
      ok: false,
      code: "tool_error",
      message: UPLOAD_UNAVAILABLE,
      effects: "none",
    });
    // Client mode keeps P5b's text, never `/mcp`'s (P7b v07 R1).
    expect(answer.ok ? "" : answer.message).not.toBe(MCP_UPLOAD_UNAVAILABLE);
    expect(who.reads()).toBe(0);
    expect(seen).toEqual([]);
  });

  test("bytes that fail the recheck fail only their item, before its write", async () => {
    const set = createToolHost(
      edgeTools({ confluenceDeletes: confluenceDeleteSwitchFor([]) }),
      { log: () => {} },
    );
    stubConfluenceWriteFetch();
    const proposal = await set.prepare(
      CONFLUENCE,
      { items: [EDIT, UPLOAD] },
      client().caller,
      { uploads: [ENTRY] },
    );
    if (!proposal.ok) throw new Error(proposal.message);
    vi.unstubAllGlobals();
    const scope = fakeScope({
      ok: true,
      upload: {
        work: ENTRY.size,
        stagedBytes: () => Promise.reject(new Error("mismatch")),
        executionSettled: () => {},
      },
      outputSettled: () => {},
    });
    const seen = stubConfluenceWriteFetch();
    const answer = await set.apply(
      CONFLUENCE,
      { site: proposal.site, items: proposal.items },
      client().caller,
      { upload: { id: "upl-1", scope } },
    );
    expect(answer).toMatchObject({ ok: true, effects: "possible" });
    const results = (
      answer as { results: { effects: string; error?: string }[] }
    ).results;
    expect(results[0]).toMatchObject({ effects: "possible" });
    expect(results[1]).toMatchObject({ effects: "none" });
    expect(JSON.stringify(results[1])).toContain(UPLOAD_MISMATCH);
    expect(seen.filter((request) => request.upload)).toEqual([]);
  });

  test("one budget: an open upload makes a download busy, and the busy texts say transfer", async () => {
    const set = edge();
    const scope = set.uploads.scope("user-1");
    sealedUpload(scope);
    const download = await set.host.callForClient(
      "confluence_download_attachment",
      { attachmentId: "att1" },
      client().caller,
    );
    expect(download).toMatchObject({ ok: false, message: FILE_BUSY });
    for (const text of [FILE_BUSY, UPLOAD_BUSY])
      expect(text).toMatch(/already transferring a file/);
  });
});
