/**
 * `fixture_file_read` (Task-1441 P7a, H3): a test-only file tool shaped like
 * a future `slack_file_read`, so the file contract is verified on a tool
 * that is not Confluence. Its limit argument is `maxDownloadBytes` (10 MiB
 * default, 20 MiB cap); a `maxBytes` argument is accepted and ignored.
 * Test-only: it lives here because only `gatewayTools/` may import the
 * descriptor (`workerBoundary.test.ts`), and it is never registered
 * (`tools.ts`), never in FILE_TOOLS, never on `/mcp`.
 *
 * `id` picks the answer: `bin` a file of `size` bytes (5 unless given),
 * `inline` text content and `limit` a `download_limit_reached`, both plain;
 * `hold` waits for `release()` before the file, ignoring its signal, as a
 * slow cleanup would. Every value is fake.
 */
import { FileResult, type AtlassianToolDescriptor } from "./descriptor.ts";

const MiB = 1024 * 1024;

const FIXTURE_FILE_SPEC = {
  limitParam: "maxDownloadBytes",
  defaultBytes: 10 * MiB,
  maxBytes: 20 * MiB,
} as const;

/** The fixture's file text: what a Slack file read would say beside it. */
export function fixtureFileText(size: number) {
  return {
    capability: "file_read",
    identity: { fileId: "F0FIXTURE" },
    file: { name: "fixture.bin", mimetype: "application/octet-stream" },
    origin: "slack",
    status: "downloaded",
    downloadedBytes: size,
  };
}

export const fixtureBytes = (size: number) =>
  new Uint8Array(size).map((_byte, index) => index % 251);

export function fixtureFileTool(
  overrides: Partial<AtlassianToolDescriptor> = {},
): AtlassianToolDescriptor & { started: number; release(): void } {
  let releases: (() => void)[] = [];
  const tool: AtlassianToolDescriptor & { started: number; release(): void } = {
    name: "fixture_file_read",
    description: "A test-only file tool.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        size: { type: "integer", minimum: 0 },
        maxDownloadBytes: { type: "number" },
        maxBytes: { type: "number" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    effect: "read",
    actionKey: "fixture:read",
    integration: "atlassian",
    file: FIXTURE_FILE_SPEC,
    started: 0,
    release() {
      const pending = releases;
      releases = [];
      for (const fn of pending) fn();
    },
    async execute(params, ctx) {
      await ctx.credential();
      tool.started += 1;
      const size = typeof params.size === "number" ? params.size : 5;
      if (params.id === "inline")
        return { ...fixtureFileText(0), status: "inline", content: "hi" };
      if (params.id === "limit")
        return { ...fixtureFileText(0), status: "download_limit_reached" };
      if (params.id === "hold")
        await new Promise<void>((resolve) => releases.push(resolve));
      return new FileResult(fixtureFileText(size), {
        name: "fixture.bin",
        mimeType: "application/octet-stream",
        bytes: fixtureBytes(size),
      });
    },
    ...overrides,
  };
  return tool;
}
