/**
 * The frozen local oracle for `confluence_download_attachment` (Task-1441
 * P7a, plan G5): the result text Pandeck's local tool answered for each case
 * below, recorded from the tool as it was before P7a changed anything. The
 * client-mode tool must answer the same text byte for byte, key order and
 * every `attachment` field included. Only the staged attachment's id and path
 * differ per run, so both are replaced by placeholders (`oracleText`).
 * Every value is fake.
 */

/** The fake site every case reads from. */
export const ORACLE_SITE = "example.atlassian.net";

/** One attachment as Confluence's v2 API describes it. */
export interface OracleAttachment {
  id: string;
  title: string;
  pageId: string;
  mediaType?: string;
  fileSize: number;
  version: { number: number };
  downloadLink: string;
}

export interface DownloadOracleCase {
  name: string;
  /** The tool's arguments. */
  args: Record<string, unknown>;
  /** The attachment the metadata read answers. */
  attachment: OracleAttachment;
  /** The download's `Content-Type`, or none. */
  contentType: string | null;
  /** The file's bytes, as UTF-8 text. */
  content: string;
  /** The local tool's result text, id and path as placeholders. */
  expected: string;
}

const attachment = (
  id: string,
  title: string,
  fileSize: number,
  mediaType?: string,
): OracleAttachment => ({
  id,
  title,
  pageId: "123",
  ...(mediaType === undefined ? {} : { mediaType }),
  fileSize,
  version: { number: 3 },
  downloadLink: `/download/attachments/123/${encodeURIComponent(title)}?version=3&api=v2`,
});

export const DOWNLOAD_ORACLE: readonly DownloadOracleCase[] = [
  {
    name: "no mediaType and no Content-Type: the name decides",
    args: { attachmentId: "att101" },
    attachment: attachment("att101", "notes.txt", 5),
    contentType: null,
    content: "hello",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att101",\n    "title": "notes.txt",\n    "mediaType": null,\n    "fileSize": 5,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/notes.txt?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "notes.txt",\n    "mimeType": "text/plain",\n    "size": 5,\n    "path": "<path>"\n  }\n}',
  },
  {
    name: "no mediaType: the header's type",
    args: { attachmentId: "att102" },
    attachment: attachment("att102", "report", 3),
    contentType: "application/pdf",
    content: "PDF",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att102",\n    "title": "report",\n    "mediaType": null,\n    "fileSize": 3,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/report?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "report",\n    "mimeType": "application/pdf",\n    "size": 3,\n    "path": "<path>"\n  }\n}',
  },
  {
    name: "a parameterized, mixed-case mediaType",
    args: { attachmentId: "att103" },
    attachment: attachment("att103", "readme", 4, "Text/Plain; charset=UTF-8"),
    contentType: "application/octet-stream",
    content: "text",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att103",\n    "title": "readme",\n    "mediaType": "Text/Plain; charset=UTF-8",\n    "fileSize": 4,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/readme?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "readme",\n    "mimeType": "text/plain",\n    "size": 4,\n    "path": "<path>"\n  }\n}',
  },
  {
    name: "the metadata's mediaType wins over the header",
    args: { attachmentId: "att104" },
    attachment: attachment("att104", "diagram.png", 4, "image/png"),
    contentType: "application/octet-stream",
    content: "PNG!",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att104",\n    "title": "diagram.png",\n    "mediaType": "image/png",\n    "fileSize": 4,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/diagram.png?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "diagram.png",\n    "mimeType": "image/png",\n    "size": 4,\n    "path": "<path>"\n  }\n}',
  },
  {
    name: "a zero-byte file",
    args: { attachmentId: "att105" },
    attachment: attachment(
      "att105",
      "empty.bin",
      0,
      "application/octet-stream",
    ),
    contentType: "application/octet-stream",
    content: "",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att105",\n    "title": "empty.bin",\n    "mediaType": "application/octet-stream",\n    "fileSize": 0,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/empty.bin?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "empty.bin",\n    "mimeType": "application/octet-stream",\n    "size": 0,\n    "path": "<path>"\n  }\n}',
  },
  {
    name: "by page and exact file name",
    args: { page: "123", fileName: "sheet.csv" },
    attachment: attachment("att106", "sheet.csv", 6, "text/csv"),
    contentType: "text/csv",
    content: "a,b\n1,",
    expected:
      '{\n  "status": "saved_attachment",\n  "pageId": "123",\n  "attachment": {\n    "id": "att106",\n    "title": "sheet.csv",\n    "mediaType": "text/csv",\n    "fileSize": 6,\n    "version": 3,\n    "downloadUrl": "https://example.atlassian.net/wiki/download/attachments/123/sheet.csv?version=3&api=v2"\n  },\n  "sessionAttachment": {\n    "id": "<id>",\n    "name": "sheet.csv",\n    "mimeType": "text/csv",\n    "size": 6,\n    "path": "<path>"\n  }\n}',
  },
];

/** `text` with the staged attachment's id and path as their placeholders. */
export function oracleText(
  text: string,
  staged: { id: string; path: string },
): string {
  return text
    .replaceAll(JSON.stringify(staged.id), '"<id>"')
    .replaceAll(JSON.stringify(staged.path), '"<path>"');
}

/**
 * A `fetch` answering the oracle's metadata reads and downloads for the site,
 * with Basic or Bearer prefixes alike; anything else is a 404.
 */
export function oracleFetch(
  cases: readonly DownloadOracleCase[] = DOWNLOAD_ORACLE,
): (input: URL | string, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/ex\/confluence\/[^/]+/, "");
    for (const entry of cases) {
      const { attachment: att } = entry;
      if (path === `/wiki/api/v2/attachments/${att.id}`)
        return Response.json(att);
      if (
        path === `/wiki/api/v2/pages/${att.pageId}/attachments` &&
        url.searchParams.get("filename") === att.title
      )
        return Response.json({ results: [att] });
      const link = new URL(`https://x.invalid/wiki${att.downloadLink}`);
      if (path === link.pathname && url.search === link.search)
        return new Response(
          new TextEncoder().encode(entry.content),
          entry.contentType === null
            ? {}
            : { headers: { "content-type": entry.contentType } },
        );
    }
    return Response.json({}, { status: 404 });
  };
}
