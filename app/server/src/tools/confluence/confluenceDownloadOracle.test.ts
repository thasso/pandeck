/**
 * The local `confluence_download_attachment` answers the frozen oracle
 * (Task-1441 P7a, plan G5): the same result text, byte for byte, for every
 * case in `test/confluenceDownloadOracle.ts`, through the real HTTP layer
 * with only `fetch` stubbed. The client-mode tool is held to the same texts.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  DOWNLOAD_ORACLE,
  ORACLE_SITE,
  oracleFetch,
  oracleText,
} from "../../test/confluenceDownloadOracle.ts";

vi.mock("../../confluenceSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../confluenceSettings.ts")>()),
  getConfluenceToolConfig: () => ({
    host: ORACLE_SITE,
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  }),
}));

const { confluenceDownloadAttachmentTool } =
  await import("./confluenceTools.ts");
const { listSessionAttachments } = await import("../../sessionAttachments.ts");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(oracleFetch()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let session = 0;

for (const entry of DOWNLOAD_ORACLE)
  test(`the local tool answers the oracle: ${entry.name}`, async () => {
    const sessionId = `oracle-${session++}`;
    const result = await confluenceDownloadAttachmentTool.execute(
      entry.args as never,
      { session: { sessionId } } as never,
    );
    const block = result.content[0];
    assert.equal(block?.type, "text");
    const [staged] = listSessionAttachments(sessionId);
    assert.ok(staged);
    assert.equal(
      oracleText(block.type === "text" ? block.text : "", staged),
      entry.expected,
    );
  });

// Characterization (G3): the local download's own refusals, exact.
test("the local download's metadata size and missing-link messages", async () => {
  const { downloadAttachment } = await import("./confluenceAttachments.ts");
  const config = {
    host: ORACLE_SITE,
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  };
  await assert.rejects(
    downloadAttachment(
      config,
      { id: "att9", title: "big.bin", fileSize: 11 },
      10,
    ),
    {
      message:
        "big.bin is 11 bytes, above the 10-byte limit; raise maxBytes to fetch it.",
    },
  );
  await assert.rejects(
    downloadAttachment(config, { id: "att9", fileSize: 11 }, 10),
    {
      message:
        "att9 is 11 bytes, above the 10-byte limit; raise maxBytes to fetch it.",
    },
  );
  await assert.rejects(downloadAttachment(config, { id: "att9" }, 10), {
    message: "Confluence returned no download link for attachment att9.",
  });
  await assert.rejects(downloadAttachment(config, {}, 10), {
    message: "Confluence returned no download link for attachment .",
  });
});
