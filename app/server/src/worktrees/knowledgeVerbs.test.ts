/**
 * Every verb the Knowledge Base checkout answers, over HTTP: each answers as
 * git says the KB is, runs git, and sends the Worker nothing (B6). Every
 * other verb answers 404 for the KB, also without the Worker. A verb added to
 * `KNOWLEDGE_VERBS` without a case here fails the first test. Run:
 *   pnpm --filter @assistant/server test src/worktrees/knowledgeVerbs.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, test } from "vitest";
import type {
  WorktreeChangesResponse,
  WorktreeCommitResponse,
  WorktreeFileDiffResponse,
  WorktreeFileLogResponse,
  WorktreeFileResponse,
  WorktreeGitStatus,
  WorktreeLogResponse,
  WorktreeTreeEntry,
} from "@assistant/shared";
import { countGitExecutionsForTests } from "../gitExec.ts";
import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { inProcessWorkerServedForTests } from "../workers/inProcessWorker.ts";
import { KNOWLEDGE_VERBS, handleWorktreeApi } from "./worktreeHttp.ts";

const BASE = "/api/worktrees/knowledge";
let root: string;

function sh(...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
    { cwd: root, encoding: "utf8" },
  );
}

const lines = (text: string) => text.split("\n").filter(Boolean);

beforeAll(async () => {
  const store = new KnowledgeBaseStore();
  await store.ensureInitialized();
  root = store.root;
  // Two commits of our own, then one edit, one new file and one ignored file.
  writeFileSync(join(root, ".gitignore"), "ignored.log\n");
  writeFileSync(join(root, "kept.md"), "kept v1\n");
  sh("add", ".gitignore", "kept.md");
  sh("commit", "-qm", "Add kept");
  writeFileSync(join(root, "second.md"), "second\n");
  sh("add", "second.md");
  sh("commit", "-qm", "Add second");
  writeFileSync(join(root, "kept.md"), "kept v2\n");
  writeFileSync(join(root, "fresh.md"), "fresh\n");
  writeFileSync(join(root, "ignored.log"), "ignored\n");
  assert.ok(lines(sh("log", "--format=%H")).length >= 2);
});

interface Answer {
  status: number;
  body: unknown;
  raw: Buffer;
}

/** Drive the handler; a payload makes it a POST with that JSON body. */
async function request(path: string, payload?: unknown): Promise<Answer> {
  let status = 0;
  let raw: Buffer = Buffer.alloc(0);
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(chunk?: string | Buffer) {
      raw = typeof chunk === "string" ? Buffer.from(chunk) : (chunk ?? raw);
    },
  } as unknown as ServerResponse;
  const bytes = Buffer.from(JSON.stringify(payload ?? {}));
  const handlers = new Map<string, (arg?: unknown) => void>();
  const req = {
    method: payload === undefined ? "GET" : "POST",
    on(event: string, cb: (arg?: unknown) => void) {
      handlers.set(event, cb);
      if (event === "end")
        queueMicrotask(() => {
          handlers.get("data")?.(bytes);
          handlers.get("end")?.();
        });
      return req;
    },
    destroy() {},
  } as unknown as IncomingMessage;
  await handleWorktreeApi(req, res, new URL(`http://x${path}`), () => ({}));
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    body = undefined;
  }
  return { status, body, raw };
}

/** One verb's requests, each checked against git's own answer. */
type VerbCase = () => Promise<void>;

async function ok<T>(path: string, payload?: unknown): Promise<T> {
  const answer = await request(path, payload);
  assert.equal(answer.status, 200, `${path}: ${answer.raw.toString("utf8")}`);
  return answer.body as T;
}

function topLevel(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.split("/")[0]!))].sort();
}

// Ordered: `commit` changes the KB, so it runs last.
const CASES: Record<string, VerbCase> = {
  status: async () => {
    const status = await ok<WorktreeGitStatus>(`${BASE}/status`);
    const porcelain = lines(sh("status", "--porcelain=v1"));
    assert.equal(status.worktreeId, "knowledge");
    assert.equal(status.branch, sh("rev-parse", "--abbrev-ref", "HEAD").trim());
    // Status abbreviates the oid to 12 characters.
    assert.equal(status.head, sh("rev-parse", "HEAD").trim().slice(0, 12));
    assert.equal(
      status.filesChanged,
      porcelain.filter((line) => !line.startsWith("??")).length,
    );
    assert.equal(
      status.untracked,
      porcelain.filter((line) => line.startsWith("??")).length,
    );
    assert.equal(status.dirty, porcelain.length > 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  },
  changes: async () => {
    const changes = await ok<WorktreeChangesResponse>(`${BASE}/changes`);
    const expected = lines(
      sh("status", "--porcelain=v1", "--untracked-files=all"),
    ).map((line) => line.slice(3));
    assert.deepEqual(changes.files.map((file) => file.path).sort(), [
      ...expected.sort(),
    ]);
    assert.equal(
      changes.files.find((file) => file.path === "fresh.md")?.status,
      "untracked",
    );
    assert.equal(
      changes.files.find((file) => file.path === "kept.md")?.status,
      "modified",
    );
    assert.equal(changes.head, sh("rev-parse", "--short", "HEAD").trim());
  },
  "file-diff": async () => {
    const diff = await ok<WorktreeFileDiffResponse>(
      `${BASE}/file-diff?path=kept.md`,
    );
    assert.equal(diff.status, "modified");
    assert.equal(diff.oldContent, sh("show", "HEAD:kept.md"));
    assert.equal(diff.newContent, readFileSync(join(root, "kept.md"), "utf8"));
    const patch = sh("diff", "--no-ext-diff", "--no-color", "HEAD", "--");
    for (const line of ["-kept v1", "+kept v2"]) {
      assert.ok(patch.includes(line));
      assert.ok(diff.diff.includes(line), line);
    }
  },
  file: async () => {
    const working = await ok<WorktreeFileResponse>(`${BASE}/file?path=kept.md`);
    assert.equal(working.content, readFileSync(join(root, "kept.md"), "utf8"));
    const atHead = await ok<WorktreeFileResponse>(
      `${BASE}/file?path=kept.md&ref=HEAD`,
    );
    assert.equal(atHead.content, sh("show", "HEAD:kept.md"));
  },
  "file-raw": async () => {
    const working = await request(`${BASE}/file-raw?path=fresh.md`);
    assert.equal(working.status, 200);
    assert.deepEqual(working.raw, readFileSync(join(root, "fresh.md")));
    const atHead = await request(`${BASE}/file-raw?path=second.md&ref=HEAD`);
    assert.equal(atHead.status, 200);
    assert.equal(atHead.raw.toString("utf8"), sh("show", "HEAD:second.md"));
  },
  log: async () => {
    const log = await ok<WorktreeLogResponse>(`${BASE}/log`);
    assert.deepEqual(
      log.entries.map((entry) => entry.oid),
      lines(sh("log", "--format=%H", "-n", "50", "HEAD")),
    );
  },
  "file-log": async () => {
    const log = await ok<WorktreeFileLogResponse>(
      `${BASE}/file-log?path=kept.md`,
    );
    assert.deepEqual(
      log.entries.map((entry) => entry.oid),
      lines(sh("log", "--follow", "--format=%H", "HEAD", "--", "kept.md")),
    );
  },
  tree: async () => {
    const tree = await ok<WorktreeTreeEntry[]>(`${BASE}/tree`);
    assert.deepEqual(
      tree.map((entry) => entry.name).sort(),
      topLevel(lines(sh("ls-files", "-co", "--exclude-standard"))),
    );
    assert.ok(!tree.some((entry) => entry.name === "ignored.log"));
    const withIgnored = await ok<WorktreeTreeEntry[]>(
      `${BASE}/tree?includeIgnored=true`,
    );
    assert.deepEqual(
      withIgnored.map((entry) => entry.name).sort(),
      topLevel([
        ...lines(sh("ls-files", "-co", "--exclude-standard")),
        ...lines(sh("ls-files", "-o", "-i", "--exclude-standard")),
      ]),
    );
  },
  commit: async () => {
    const committed = await ok<WorktreeCommitResponse>(`${BASE}/commit`, {
      message: "Add fresh",
      paths: ["fresh.md"],
    });
    assert.equal(committed.status, "committed");
    assert.equal(
      committed.commitHash,
      sh("rev-parse", "--short", "HEAD").trim(),
    );
    assert.equal(sh("log", "-1", "--format=%s").trim(), "Add fresh");
    assert.deepEqual(lines(sh("show", "--format=", "--name-only", "HEAD")), [
      "fresh.md",
    ]);
  },
};

test("the case list is exactly the Knowledge Base verbs", () => {
  assert.deepEqual(Object.keys(CASES).sort(), [...KNOWLEDGE_VERBS].sort());
});

for (const [verb, check] of Object.entries(CASES))
  test(`KB ${verb} answers as git does, on the server`, async () => {
    const before = inProcessWorkerServedForTests();
    const { executions } = await countGitExecutionsForTests(check);
    assert.equal(
      inProcessWorkerServedForTests() - before,
      0,
      "Worker requests",
    );
    assert.ok(executions > 0, "the verb ran git");
  });

test("every other verb is 404 for the Knowledge Base, without the Worker", async () => {
  const others = {
    get: ["hosting"],
    post: [
      "auto-commit",
      "clean",
      "push",
      "pull-rebase",
      "rebase-main",
      "fast-forward-main",
      "create-pr",
      "merge-pr",
      "retire",
    ],
  };
  const before = inProcessWorkerServedForTests();
  for (const verb of [...others.get, ...others.post]) {
    assert.ok(!KNOWLEDGE_VERBS.has(verb), verb);
    const answer = await request(
      `${BASE}/${verb}`,
      others.post.includes(verb) ? {} : undefined,
    );
    assert.equal(answer.status, 404, verb);
    assert.match(
      (answer.body as { error: string }).error,
      /Not available for the Knowledge Base/,
    );
  }
  assert.equal(inProcessWorkerServedForTests() - before, 0);
});
