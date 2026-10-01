/**
 * HTTP read-surface tests: the widened route must serve a percent-encoded
 * synthetic `main:<projectId>` id, reject malformed percent-encoding with a
 * controlled 400 (not an unhandled throw), and 404 an unknown worktree. Run:
 *   pnpm --filter @assistant/server test src/worktrees/worktreeHttp.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "worktree-http-test-"));
process.env.ASSISTANT_CWD = tmp;

const { handleWorktreeApi } = await import("./worktreeHttp.ts");
const { mainWorktreeId } = await import("./worktreeResolve.ts");
const { projectStore } = await import("../db/projectStore.ts");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" },
  );
}

const repoPath = join(tmp, "httprepo");
mkdirSync(repoPath, { recursive: true });
sh(repoPath, "init", "-b", "main");
writeFileSync(join(repoPath, "readme.md"), "hello\n");
sh(repoPath, "add", "-A");
sh(repoPath, "commit", "-m", "init");

projectStore.put({
  id: "http-proj",
  name: "Http Project",
  key: "HP",
  description: "",
  status: "active",
  localPaths: [{ path: repoPath, kind: "repo", match: "prefix" }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

/** Drive the handler against a path and return {status, body, raw bytes, headers}. */
async function callRaw(
  pathname: string,
): Promise<{ status: number; raw: Buffer; headers: Record<string, string> }> {
  let status = 0;
  let raw: Buffer = Buffer.alloc(0);
  let headers: Record<string, string> = {};
  const res = {
    writeHead(code: number, sent?: Record<string, string>) {
      status = code;
      headers = sent ?? {};
    },
    end(chunk?: string | Buffer) {
      raw =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : (chunk ?? Buffer.alloc(0));
    },
  } as unknown as ServerResponse;
  const req = { method: "GET" } as IncomingMessage;
  await handleWorktreeApi(req, res, new URL(`http://x${pathname}`), () => ({}));
  return { status, raw, headers };
}

async function call(
  pathname: string,
): Promise<{ status: number; body: unknown }> {
  const { status, raw } = await callRaw(pathname);
  return {
    status,
    body: raw.length ? JSON.parse(raw.toString("utf8")) : undefined,
  };
}

/** Drive the handler with a POST + JSON body (fake streamed request). */
async function postJson(
  pathname: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  let status = 0;
  let raw = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string) {
      raw = typeof chunk === "string" ? chunk : "";
    },
  } as unknown as ServerResponse;
  const bytes = Buffer.from(JSON.stringify(payload ?? {}));
  const handlers = new Map<string, (arg?: unknown) => void>();
  const req = {
    method: "POST",
    on(event: string, cb: (arg?: unknown) => void) {
      handlers.set(event, cb);
      if (event === "end") {
        queueMicrotask(() => {
          handlers.get("data")?.(bytes);
          handlers.get("end")?.();
        });
      }
      return req;
    },
    destroy() {},
  } as unknown as IncomingMessage;
  await handleWorktreeApi(req, res, new URL(`http://x${pathname}`), () => ({}));
  return { status, body: raw ? JSON.parse(raw) : undefined };
}

test("serves a percent-encoded main:<projectId> status route", async () => {
  const id = mainWorktreeId("http-proj");
  const { status, body } = await call(
    `/api/worktrees/${encodeURIComponent(id)}/status`,
  );
  assert.equal(status, 200);
  assert.equal((body as { worktreeId: string }).worktreeId, id);
});

test("malformed percent-encoding is a controlled 400, not a crash", async () => {
  const { status } = await call("/api/worktrees/%E0%A4%A/status");
  assert.equal(status, 400);
});

test("unknown worktree id is a 404", async () => {
  const { status } = await call(
    `/api/worktrees/${encodeURIComponent(mainWorktreeId("does-not-exist"))}/status`,
  );
  assert.equal(status, 404);
});

test("file-raw serves working-tree bytes with a content type", async () => {
  const id = mainWorktreeId("http-proj");
  // A binary file (PNG magic + a NUL) must round-trip byte-exact.
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02,
  ]);
  writeFileSync(join(repoPath, "pixel.png"), bytes);
  const { status, raw, headers } = await callRaw(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=pixel.png`,
  );
  assert.equal(status, 200);
  assert.equal(headers["content-type"], "image/png");
  assert.deepEqual(raw, bytes);

  const md = await callRaw(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=readme.md`,
  );
  assert.equal(md.status, 200);
  assert.match(md.headers["content-type"] ?? "", /text\/markdown/);
  assert.equal(md.raw.toString("utf8"), "hello\n");
});

test("file-raw serves committed bytes at a ref and rejects bad input", async () => {
  const id = mainWorktreeId("http-proj");
  const head = sh(repoPath, "rev-parse", "HEAD").trim();
  const atRef = await callRaw(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=readme.md&ref=${head}`,
  );
  assert.equal(atRef.status, 200);
  assert.equal(atRef.raw.toString("utf8"), "hello\n");

  // Untracked-at-ref → 404; traversal + option-shaped refs → controlled 4xx.
  const missing = await callRaw(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=pixel.png&ref=${head}`,
  );
  assert.equal(missing.status, 404);
  const traversal = await call(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=${encodeURIComponent("../outside.txt")}`,
  );
  assert.equal(traversal.status, 400);
  const badRef = await call(
    `/api/worktrees/${encodeURIComponent(id)}/file-raw?path=readme.md&ref=${encodeURIComponent("--output=/tmp/x")}`,
  );
  assert.equal(badRef.status, 400);
});

test("commit verb stages and commits on the main checkout; empty message rejected", async () => {
  const id = mainWorktreeId("http-proj");
  writeFileSync(join(repoPath, "notes.txt"), "phase four\n");

  const empty = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/commit`,
    { message: "  " },
  );
  assert.equal(empty.status, 400);

  const committed = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/commit`,
    { message: "Add notes" },
  );
  assert.equal(committed.status, 200);
  const result = committed.body as { status: string; commitHash?: string };
  assert.equal(result.status, "committed");
  assert.ok(result.commitHash);
  assert.match(sh(repoPath, "log", "-1", "--format=%s"), /Add notes/);
  assert.equal(sh(repoPath, "status", "--porcelain").trim(), "");

  const nothing = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/commit`,
    { message: "Again" },
  );
  assert.equal(
    (nothing.body as { status: string }).status,
    "nothing-to-commit",
  );

  // GET on a write verb is refused.
  const wrongMethod = await call(
    `/api/worktrees/${encodeURIComponent(id)}/commit`,
  );
  assert.equal(wrongMethod.status, 405);
});

test("clean verb resets tracked edits to HEAD, removes untracked files, and preserves commits + ignored files", async () => {
  const id = mainWorktreeId("http-proj");
  const head = sh(repoPath, "rev-parse", "HEAD").trim();
  writeFileSync(join(repoPath, "readme.md"), "changed\n");
  writeFileSync(join(repoPath, "scratch.txt"), "discard me\n");
  writeFileSync(join(repoPath, ".git", "info", "exclude"), "ignored.tmp\n");
  writeFileSync(join(repoPath, "ignored.tmp"), "keep me\n");

  const cleaned = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/clean`,
    {},
  );
  assert.equal(cleaned.status, 200);
  assert.equal((cleaned.body as { status: string }).status, "cleaned");
  assert.equal(readFileSync(join(repoPath, "readme.md"), "utf8"), "hello\n");
  assert.equal(existsSync(join(repoPath, "scratch.txt")), false);
  assert.equal(
    readFileSync(join(repoPath, "ignored.tmp"), "utf8"),
    "keep me\n",
  );
  assert.equal(
    sh(repoPath, "rev-parse", "HEAD").trim(),
    head,
    "clean must preserve branch commits",
  );

  const nothing = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/clean`,
    {},
  );
  assert.equal((nothing.body as { status: string }).status, "nothing-to-clean");

  // Worktree-page auto-commit uses the shared workflow without requiring a
  // session. A clean tree blocks before invoking the configured message agent.
  const auto = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/auto-commit`,
    {},
  );
  assert.equal(auto.status, 200);
  assert.equal(
    (auto.body as { result: { status: string } }).result.status,
    "blocked",
  );
});

test("push verb pushes to the remote, sets the upstream, and reports state", async () => {
  const id = mainWorktreeId("http-proj");
  const barePath = join(tmp, "bare.git");
  mkdirSync(barePath, { recursive: true });
  sh(barePath, "init", "--bare");
  sh(repoPath, "remote", "add", "origin", barePath);

  const pushed = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/push`,
    {},
  );
  assert.equal(pushed.status, 200);
  const result = pushed.body as {
    status: string;
    remote?: string;
    branch?: string;
    setUpstream: boolean;
  };
  assert.equal(result.status, "pushed");
  assert.equal(result.remote, "origin");
  assert.equal(result.branch, "main");
  assert.equal(result.setUpstream, true);
  assert.equal(
    sh(barePath, "rev-parse", "main").trim(),
    sh(repoPath, "rev-parse", "HEAD").trim(),
  );

  const again = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/push`,
    {},
  );
  assert.equal((again.body as { status: string }).status, "up-to-date");

  // The status surface now reports upstream push state (nothing unpushed).
  const status = await call(`/api/worktrees/${encodeURIComponent(id)}/status`);
  const upstream = (
    status.body as { upstream?: { ahead: number; behind: number } }
  ).upstream;
  assert.deepEqual(upstream, {
    ahead: 0,
    behind: 0,
    name: "origin/main",
  });
});

test("hosting status degrades to provider-less for repos without a matching remote", async () => {
  const id = mainWorktreeId("http-proj");
  const { status, body } = await call(
    `/api/worktrees/${encodeURIComponent(id)}/hosting`,
  );
  assert.equal(status, 200);
  // origin is a local bare path here — no provider resolves, no PR/CI fields.
  assert.deepEqual(body, { worktreeId: id });

  const createPr = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/create-pr`,
    { title: "x" },
  );
  assert.equal(createPr.status, 400);
});

// The merge method decides how history is rewritten, so it is validated at the
// edge rather than defaulted — and the main checkout has no PR of its own.
test("merge-pr validates the method and refuses the main checkout", async () => {
  const id = mainWorktreeId("http-proj");
  const badMethod = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/merge-pr`,
    { method: "octopus" },
  );
  assert.equal(badMethod.status, 400);
  assert.match((badMethod.body as { error: string }).error, /merge method/i);

  const onMain = await postJson(
    `/api/worktrees/${encodeURIComponent(id)}/merge-pr`,
    { method: "squash" },
  );
  assert.equal(onMain.status, 400);
  assert.match(
    (onMain.body as { error: string }).error,
    /main checkout has no pull request/i,
  );
});

test("merge-pr is POST-only", async () => {
  const id = mainWorktreeId("http-proj");
  const { status } = await call(
    `/api/worktrees/${encodeURIComponent(id)}/merge-pr`,
  );
  assert.equal(status, 405);
});

test("retire is POST-only and refuses the main checkout", async () => {
  const id = mainWorktreeId("http-proj");
  const path = `/api/worktrees/${encodeURIComponent(id)}/retire`;
  assert.equal((await call(path)).status, 405);
  const invalid = await postJson(path, { deleteBranch: "false" });
  assert.equal(invalid.status, 400);
  assert.match((invalid.body as { error: string }).error, /boolean values/i);

  const result = await postJson(path, {});
  assert.equal(result.status, 400);
  assert.match((result.body as { error: string }).error, /cannot be retired/i);
});
