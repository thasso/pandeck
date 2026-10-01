import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, test, vi } from "vitest";

const disk = vi.hoisted(() => ({ availableBytes: null as number | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (path: string) =>
      disk.availableBytes === null
        ? actual.statfs(path)
        : { bavail: disk.availableBytes, bsize: 1 },
  };
});

vi.mock("../../googleSettings.ts", () => ({
  getGoogleToolConfig: () => ({ enabled: true }),
  ensureGoogleAccessToken: async () => "drive-token",
}));

import { DATA_DIR } from "../../config.ts";
import {
  deleteSessionArtifacts,
  listSessionArtifacts,
} from "../../mcp/toolGroups/packRuntime.ts";
import {
  googleDriveDownloadTool,
  googleDriveGetFileTool,
  googleDriveSearchFilesTool,
} from "./googleDriveTools.ts";

const sessionIds: string[] = [];

function context(sessionId: string) {
  sessionIds.push(sessionId);
  return {
    toolCallId: "call",
    session: {
      sessionId,
      harness: "pi" as const,
      agentType: "assistant" as const,
    },
    signal: new AbortController().signal,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function artifactBytes(url: string): Buffer {
  const pathname = new URL(url, "http://localhost").pathname;
  const relative = pathname.slice("/api/session-artifacts/".length);
  return readFileSync(
    join(
      DATA_DIR,
      "session-artifacts",
      ...relative.split("/").map(decodeURIComponent),
    ),
  );
}

const GIB = 1024 * 1024 * 1024;

function driveArtifactFiles(sessionId: string): string[] {
  const directory = join(
    DATA_DIR,
    "session-artifacts",
    sessionId,
    "google-drive",
  );
  return existsSync(directory) ? readdirSync(directory) : [];
}

function chunkedResponse(chunks: Uint8Array[], failAfter = false): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (failAfter) controller.error(new Error("connection reset"));
        else controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    },
  );
}

/** Check the central directory and end record against the local headers. */
function assertZipDirectory(bytes: Buffer, entries: Map<string, Buffer>) {
  const endOffset = bytes.byteLength - 22;
  assert.equal(bytes.readUInt32LE(endOffset), 0x06054b50);
  const count = bytes.readUInt16LE(endOffset + 10);
  const directorySize = bytes.readUInt32LE(endOffset + 12);
  const directoryOffset = bytes.readUInt32LE(endOffset + 16);
  assert.equal(count, entries.size);
  assert.equal(directoryOffset + directorySize, endOffset);
  let offset = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const crc = bytes.readUInt32LE(offset + 16);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    const data = entries.get(name);
    assert.ok(data, `central entry ${name} has a local entry`);
    assert.equal(size, data.byteLength);
    assert.equal(crc, crc32(data));
    assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(bytes.readUInt32LE(localOffset + 14), crc);
    assert.equal(
      bytes
        .subarray(localOffset + 30, localOffset + 30 + nameLength)
        .toString("utf8"),
      name,
    );
    offset += 46 + nameLength;
  }
  assert.equal(offset, endOffset);
}

function storedZipEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const crc = bytes.readUInt32LE(offset + 14);
    const size = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = bytes
      .subarray(nameStart, nameStart + nameLength)
      .toString("utf8");
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(crc, crc32(data), `CRC of ${name}`);
    entries.set(name, data);
    offset = dataStart + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return entries;
}

afterEach(() => {
  vi.restoreAllMocks();
  disk.availableBytes = null;
  for (const sessionId of sessionIds.splice(0))
    deleteSessionArtifacts(sessionId);
});

describe("google_drive_download", () => {
  test("downloads a binary file into an authenticated session artifact", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media")
        return new Response(Buffer.from([0, 1, 2, 255]), {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": "4",
          },
        });
      return jsonResponse({
        id: "binary-1",
        name: "report (final).pdf",
        mimeType: "application/pdf",
        size: "4",
        webViewLink: "https://drive.google.com/file/d/binary-1/view",
      });
    });

    const result = await googleDriveDownloadTool.execute(
      { fileId: "binary-1" },
      context("drive-binary"),
    );
    const payload = result.details as {
      status: string;
      fileCount: number;
      artifact: { url: string; name: string; kind: string };
      markdownDownloadLink: string;
    };

    assert.equal(payload.status, "saved_artifact");
    assert.equal(payload.fileCount, 1);
    assert.equal(payload.artifact.name, "report (final).pdf");
    assert.equal(payload.artifact.kind, "download");
    assert.match(
      payload.artifact.url,
      /\?download=1&name=report%20%28final%29\.pdf$/,
    );
    assert.match(
      payload.markdownDownloadLink,
      /^\[Download report \(final\)\.pdf\]\(/,
    );
    assert.deepEqual([...artifactBytes(payload.artifact.url)], [0, 1, 2, 255]);
    assert.equal(listSessionArtifacts("drive-binary").length, 1);
  });

  test("streams a multi-chunk file to disk and returns its local path", async () => {
    const chunks = [0x11, 0x22, 0x33].map((fill) =>
      new Uint8Array(256 * 1024).fill(fill),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(chunk);
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "video/mp4" } },
        );
      return jsonResponse({
        id: "video-1",
        name: "4K_video.mp4",
        mimeType: "video/mp4",
      });
    });

    const result = await googleDriveDownloadTool.execute(
      { fileId: "video-1" },
      context("drive-stream"),
    );
    const payload = result.details as {
      sourceBytes: number;
      localPath: string;
      artifact: { url: string; size: number; mimeType: string };
    };

    const expected = Buffer.concat(chunks);
    assert.equal(payload.sourceBytes, expected.byteLength);
    assert.equal(payload.artifact.size, expected.byteLength);
    assert.equal(payload.artifact.mimeType, "video/mp4");
    assert.ok(readFileSync(payload.localPath).equals(expected));
    assert.ok(artifactBytes(payload.artifact.url).equals(expected));
  });

  test("exports nested folders as a ZIP and keeps empty directories", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path.endsWith("/files/folder-1"))
        return jsonResponse({
          id: "folder-1",
          name: "Project files",
          mimeType: "application/vnd.google-apps.folder",
        });
      if (path.endsWith("/files/empty-folder"))
        return jsonResponse({
          id: "empty-folder",
          name: "Empty",
          mimeType: "application/vnd.google-apps.folder",
        });
      if (path.endsWith("/files") && url.searchParams.has("q")) {
        const query = url.searchParams.get("q") ?? "";
        if (query.includes("'folder-1' in parents"))
          return jsonResponse({
            files: [
              {
                id: "doc-1",
                name: "Plan",
                mimeType: "application/vnd.google-apps.document",
                exportLinks: {
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                    "https://example.invalid/docx",
                },
              },
              {
                id: "raw-1",
                name: "image.bin",
                mimeType: "application/octet-stream",
                size: "3",
              },
              {
                id: "empty-folder",
                name: "Empty",
                mimeType: "application/vnd.google-apps.folder",
              },
            ],
          });
        if (query.includes("'empty-folder' in parents"))
          return jsonResponse({ files: [] });
      }
      if (path.endsWith("/files/doc-1/export"))
        return new Response(Buffer.from("docx"), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      if (
        path.endsWith("/files/raw-1") &&
        url.searchParams.get("alt") === "media"
      )
        return new Response(Buffer.from([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      throw new Error(`Unexpected Drive request: ${url}`);
    });

    const result = await googleDriveDownloadTool.execute(
      { fileId: "folder-1" },
      context("drive-folder"),
    );
    const payload = result.details as {
      folder: boolean;
      fileCount: number;
      folderCount: number;
      sourceBytes: number;
      artifact: { url: string; name: string; mimeType: string };
    };
    assert.equal(payload.folder, true);
    assert.equal(payload.fileCount, 2);
    assert.equal(payload.folderCount, 2);
    assert.equal(payload.sourceBytes, 7);
    assert.equal(payload.artifact.name, "Project files.zip");
    assert.equal(payload.artifact.mimeType, "application/zip");

    const zip = artifactBytes(payload.artifact.url);
    const entries = storedZipEntries(zip);
    assertZipDirectory(zip, entries);
    assert.equal(entries.get("Plan.docx")?.toString("utf8"), "docx");
    assert.deepEqual([...(entries.get("image.bin") ?? [])], [7, 8, 9]);
    assert.ok(entries.has("Empty/"));
  });

  test("stops before a response above maxDownloadBytes is buffered", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media")
        return new Response(Buffer.from("oversized"), {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "9",
          },
        });
      return jsonResponse({
        id: "unknown-size",
        name: "large.bin",
        mimeType: "application/octet-stream",
      });
    });

    await assert.rejects(
      googleDriveDownloadTool.execute(
        { fileId: "unknown-size", maxDownloadBytes: 4 },
        context("drive-limit"),
      ),
      /above the remaining 4-byte maxDownloadBytes limit/,
    );
    assert.deepEqual(listSessionArtifacts("drive-limit"), []);
    assert.deepEqual(driveArtifactFiles("drive-limit"), []);
  });

  test("removes the partial file when the stream fails midway", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media")
        return chunkedResponse([new Uint8Array(1024).fill(1)], true);
      return jsonResponse({
        id: "reset-1",
        name: "reset.bin",
        mimeType: "application/octet-stream",
      });
    });

    await assert.rejects(
      googleDriveDownloadTool.execute(
        { fileId: "reset-1" },
        context("drive-reset"),
      ),
      /connection reset/,
    );
    assert.deepEqual(listSessionArtifacts("drive-reset"), []);
    assert.deepEqual(driveArtifactFiles("drive-reset"), []);
  });

  test("checks disk space against the Drive size when the response has no length", async () => {
    disk.availableBytes = 2 * GIB + 50;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.get("alt") === "media")
        return chunkedResponse([new Uint8Array(100)]);
      return jsonResponse({
        id: "sized-1",
        name: "sized.bin",
        mimeType: "application/octet-stream",
        size: "100",
      });
    });

    await assert.rejects(
      googleDriveDownloadTool.execute(
        { fileId: "sized-1" },
        context("drive-disk-sized"),
      ),
      /Not enough free disk space to save sized\.bin/,
    );
    assert.deepEqual(driveArtifactFiles("drive-disk-sized"), []);
  });

  test("keeps the disk reserve for a download of unknown size", async () => {
    disk.availableBytes = 2 * GIB - 1;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/export"))
        return chunkedResponse([Buffer.from("docx")]);
      return jsonResponse({
        id: "doc-1",
        name: "Plan",
        mimeType: "application/vnd.google-apps.document",
        exportLinks: { "application/pdf": "https://example.invalid/pdf" },
      });
    });

    await assert.rejects(
      googleDriveDownloadTool.execute(
        { fileId: "doc-1" },
        context("drive-disk-unknown"),
      ),
      /Not enough free disk space to save Plan\.pdf/,
    );
    assert.deepEqual(listSessionArtifacts("drive-disk-unknown"), []);
  });
});

type SearchPayload = {
  driveQuery: string;
  folderId: string | null;
  fileCount: number;
  nextPageToken: string | null;
  files: { id: string | null; name: string; mimeType: string | null }[];
};

function folderListingFetch(pages: DriveFilesPageStub[]) {
  const requests: URL[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input));
    requests.push(url);
    const index = Number(url.searchParams.get("pageToken") ?? "0");
    const page = pages[index];
    if (!page) throw new Error(`Unexpected Drive request: ${url}`);
    return jsonResponse(page);
  });
  return requests;
}

type DriveFilesPageStub = {
  files: { id: string; name: string; mimeType: string }[];
  nextPageToken?: string;
};

describe("google_drive_search_files", () => {
  test("lists the direct children of a folder, subfolders included, in natural name order", async () => {
    const requests = folderListingFetch([
      {
        files: [
          {
            id: "sub-1",
            name: "Archive",
            mimeType: "application/vnd.google-apps.folder",
          },
          { id: "note-1", name: "notes.txt", mimeType: "text/plain" },
        ],
      },
    ]);

    const result = await googleDriveSearchFilesTool.execute(
      { folderId: "folder-1" },
      context("drive-list"),
    );
    const payload = result.details as SearchPayload;

    assert.equal(payload.folderId, "folder-1");
    assert.equal(
      payload.driveQuery,
      "trashed = false and 'folder-1' in parents",
    );
    assert.equal(payload.fileCount, 2);
    assert.equal(payload.nextPageToken, null);
    assert.deepEqual(
      payload.files.map((file) => file.mimeType),
      ["application/vnd.google-apps.folder", "text/plain"],
    );
    assert.equal(requests[0]?.searchParams.get("orderBy"), "name_natural");
    assert.equal(
      requests[0]?.searchParams.get("includeItemsFromAllDrives"),
      "true",
    );
  });

  test("reads the folder id out of a Drive folder URL and filters within it", async () => {
    folderListingFetch([{ files: [] }]);

    const result = await googleDriveSearchFilesTool.execute(
      {
        folderId: "https://drive.google.com/drive/folders/folder-9?usp=sharing",
        name: "budget",
      },
      context("drive-list-url"),
    );
    const payload = result.details as SearchPayload;

    assert.equal(payload.folderId, "folder-9");
    assert.equal(
      payload.driveQuery,
      "trashed = false and name contains 'budget' and 'folder-9' in parents",
    );
  });

  test("stops at maxResults and returns the token to continue enumerating", async () => {
    const requests = folderListingFetch([
      {
        files: [
          { id: "a", name: "A", mimeType: "text/plain" },
          { id: "b", name: "B", mimeType: "text/plain" },
        ],
        nextPageToken: "1",
      },
      { files: [{ id: "c", name: "C", mimeType: "text/plain" }] },
    ]);

    const first = await googleDriveSearchFilesTool.execute(
      { folderId: "folder-1", maxResults: 2 },
      context("drive-page-1"),
    );
    const firstPayload = first.details as SearchPayload;
    assert.equal(firstPayload.fileCount, 2);
    assert.equal(firstPayload.nextPageToken, "1");
    assert.equal(requests[0]?.searchParams.get("pageSize"), "2");

    const second = await googleDriveSearchFilesTool.execute(
      { folderId: "folder-1", maxResults: 2, pageToken: "1" },
      context("drive-page-2"),
    );
    const secondPayload = second.details as SearchPayload;
    assert.deepEqual(
      secondPayload.files.map((file) => file.id),
      ["c"],
    );
    assert.equal(secondPayload.nextPageToken, null);
  });

  test("restricts the query to folders when foldersOnly is set", async () => {
    folderListingFetch([{ files: [] }]);

    const result = await googleDriveSearchFilesTool.execute(
      { name: "Invoices", foldersOnly: true },
      context("drive-folders-only"),
    );

    assert.equal(
      (result.details as SearchPayload).driveQuery,
      "trashed = false and name contains 'Invoices' and mimeType = 'application/vnd.google-apps.folder'",
    );
  });
});

describe("google_drive_get_file", () => {
  test("points at the listing tool when the id is a folder", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({
        id: "folder-1",
        name: "Project files",
        mimeType: "application/vnd.google-apps.folder",
      }),
    );

    await assert.rejects(
      googleDriveGetFileTool.execute(
        { fileId: "folder-1" },
        context("drive-get-folder"),
      ),
      /google_drive_search_files folderId="folder-1"/,
    );
  });
});
