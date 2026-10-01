/**
 * The `/api/skills/*` read surface ([Task-614](pa://task/614)).
 *
 * What is asserted here is the boundary, not the read itself
 * (`skillDetail.test.ts` owns that): only GET is answered, the name is the
 * whole address and a path-shaped one is refused before any scan, an unknown
 * name is a 404, and a valid one serves the shared wire model. Run:
 *   pnpm --filter @assistant/server test src/skills/skillsHttp.test.ts
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import type { SkillDetailResponse } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "skills-http-test-"));
process.env.DATA_DIR = tmp;

const { handleSkillsApi } = await import("./skillsHttp.ts");

function writeSkill(folder: string, frontmatter: string, body: string): void {
  mkdirSync(join(tmp, "skills", folder), { recursive: true });
  writeFileSync(
    join(tmp, "skills", folder, "SKILL.md"),
    `---\n${frontmatter}\n---\n${body}`,
    "utf8",
  );
}

writeSkill(
  "notes-folder",
  "name: release-notes\ndescription: Draft release notes.",
  "# Release notes\n\nSteps here.\n",
);
writeSkill("half-written", "name: half-written\ndescription: ''", "# Body\n");
mkdirSync(join(tmp, "skills", "notes-folder", "references"));
writeFileSync(
  join(tmp, "skills", "notes-folder", "references", "guide.md"),
  "# Guide\n",
);
writeFileSync(
  join(tmp, "skills", "notes-folder", "references", "data.bin"),
  Buffer.from([1, 2, 3]),
);
const outside = join(tmp, "outside.txt");
writeFileSync(outside, "outside\n");
symlinkSync(outside, join(tmp, "skills", "notes-folder", "escape.txt"));

async function call(
  pathname: string,
  method = "GET",
): Promise<{
  status: number;
  body: Record<string, unknown>;
  raw: Buffer;
  headers: Record<string, string>;
}> {
  let status = 0;
  let raw: Buffer = Buffer.alloc(0);
  let responseHeaders: Record<string, string> = {};
  const res = {
    writeHead(code: number, headers?: Record<string, string>) {
      status = code;
      responseHeaders = headers ?? {};
    },
    end(chunk?: string | Buffer) {
      raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
    },
  } as unknown as ServerResponse;
  await handleSkillsApi(
    { method } as IncomingMessage,
    res,
    new URL(`http://x${pathname}`),
    () => ({}),
  );
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw.toString("utf8") || "{}") as Record<string, unknown>;
  } catch {
    // Raw file responses are deliberately not JSON.
  }
  return { status, body, raw, headers: responseHeaders };
}

test("serves one skill by declared name", async () => {
  const { status, body } = await call("/api/skills/detail?name=release-notes");

  assert.equal(status, 200);
  const detail = body as unknown as SkillDetailResponse;
  assert.equal(detail.kind, "skill");
  if (detail.kind !== "skill") return;
  assert.equal(detail.name, "release-notes");
  assert.equal(detail.path, "notes-folder/SKILL.md");
  assert.equal(detail.markdown, "# Release notes\n\nSteps here.");
  assert.equal(detail.truncated, false);
});

test("answers a known but unusable name with its reason, not an error status", async () => {
  const { status, body } = await call("/api/skills/detail?name=half-written");

  assert.equal(status, 200);
  const detail = body as unknown as SkillDetailResponse;
  assert.equal(detail.kind, "invalid");
  if (detail.kind !== "invalid") return;
  assert.equal(detail.name, "half-written");
  assert.match(detail.error, /description must not be empty/);
  assert.equal(JSON.stringify(body).includes("# Body"), false);
});

test("refuses a path instead of a name, without scanning for it", async () => {
  for (const name of [
    "../../etc/passwd",
    "notes-folder%2FSKILL.md",
    "Release-Notes",
  ]) {
    const { status, body } = await call(`/api/skills/detail?name=${name}`);
    assert.equal(status, 400, name);
    assert.equal(body.error, "Invalid skill name.");
  }
});

test("asks for a name when none was given", async () => {
  const { status, body } = await call("/api/skills/detail?name=%20");

  assert.equal(status, 400);
  assert.equal(body.error, "A skill name is required.");
});

test("404s a well-formed name the library does not declare", async () => {
  const { status, body } = await call("/api/skills/detail?name=absent-skill");

  assert.equal(status, 404);
  assert.match(String(body.error), /No skill named "absent-skill"/);
});

test("serves bounded raw and text-preview file responses with MIME handling", async () => {
  const raw = await call(
    "/api/skills/file?name=release-notes&path=references%2Fguide.md",
  );
  assert.equal(raw.status, 200);
  assert.equal(raw.raw.toString("utf8"), "# Guide\n");
  assert.equal(raw.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(raw.headers["x-content-type-options"], "nosniff");

  const preview = await call(
    "/api/skills/file?name=release-notes&path=references%2Fguide.md&preview=text",
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.body.kind, "text");
  assert.equal(preview.body.text, "# Guide\n");

  const binary = await call(
    "/api/skills/file?name=release-notes&path=references%2Fdata.bin&preview=text",
  );
  assert.equal(binary.body.kind, "binary");
  assert.equal(binary.body.mimeType, "application/octet-stream");
});

test("rejects traversal, encoded traversal, absolute paths, and symlink escapes", async () => {
  for (const path of [
    "..%2Foutside.txt",
    "%252e%252e%252Foutside.txt",
    "%2Fetc%2Fpasswd",
    "references%5Cguide.md",
    "references%2F..%2FSKILL.md",
    "escape.txt",
  ]) {
    const result = await call(
      `/api/skills/file?name=release-notes&path=${path}`,
    );
    assert.equal(
      [400, 404].includes(result.status),
      true,
      `${path}: ${result.status}`,
    );
    assert.equal(result.raw.toString("utf8").includes("outside"), false);
  }
});

test("reports a missing/deleted supporting file without leaking filesystem paths", async () => {
  const result = await call(
    "/api/skills/file?name=release-notes&path=gone.txt",
  );
  assert.equal(result.status, 404);
  assert.equal(result.raw.toString("utf8").includes(tmp), false);
});

test("answers 405 for anything but GET, and 404 for an unknown route", async () => {
  assert.equal(
    (await call("/api/skills/detail?name=release-notes", "POST")).status,
    405,
  );
  assert.equal((await call("/api/skills/whatever")).status, 404);
});
