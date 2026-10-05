import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { documentTargetHref } from "@assistant/shared/documentTargets";
import { buildFileContextAttachment } from "./fileContext.ts";

const dir = mkdtempSync(join(tmpdir(), "file-context-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "plan.md");
writeFileSync(file, "# Plan\n\nSECRET BODY SHOULD NOT RIDE ALONG\n");

function body(data: string): string {
  return Buffer.from(data, "base64").toString("utf8");
}

describe("buildFileContextAttachment", () => {
  test("names the file and its path, never its content", async () => {
    const href = documentTargetHref({ kind: "hostFile", path: file });
    const attachment = await buildFileContextAttachment(href);
    assert.ok(attachment);
    assert.equal(attachment.role, "file-context");
    assert.equal(attachment.name, "plan.md");
    assert.match(attachment.id, /^filectx-[A-Za-z0-9_-]{1,48}$/);
    const text = body(attachment.data);
    assert.ok(text.includes(`- Path: ${file}`));
    assert.ok(text.includes(`- Opened from: ${href}`));
    assert.ok(!text.includes("SECRET BODY"));
  });

  test("drops the line anchor the reader arrived with", async () => {
    const href = documentTargetHref({
      kind: "hostFile",
      path: file,
      anchor: { start: 3, end: 3 },
    });
    const attachment = await buildFileContextAttachment(href);
    assert.ok(attachment);
    assert.ok(!body(attachment.data).includes("#L3"));
  });

  test("attaches nothing for a target it cannot resolve", async () => {
    assert.equal(await buildFileContextAttachment("not a target"), undefined);
    assert.equal(
      await buildFileContextAttachment(
        documentTargetHref({
          kind: "worktreeFile",
          worktreeId: "no-such-worktree",
          path: "readme.md",
          view: "file",
        }),
      ),
      undefined,
    );
  });
});
