/**
 * The side each document grant source is read and served on (RD-W3c-2): the
 * Knowledge Base row's files and session artifacts are server data by kind,
 * and any other worktree's file is served where its path is placed. Every
 * served call names its side through the mandatory-side adapters.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { KNOWLEDGE_WORKTREE_ID } from "@assistant/shared";
import type { MintFileGrantRequest } from "@assistant/shared/servedFiles";
import { DATA_DIR } from "./config.ts";
import type { WorktreeRow } from "./db/worktreeStore.ts";
import { mintDocumentGrantOn } from "./directFileGrants.ts";
import {
  mintDocumentTargetGrant,
  resolveDocumentTargetPath,
  type DocumentGrantResolverDependencies,
} from "./documentGrantTargets.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import { realpathServedFileOn, servedSideOf } from "./servedFileAccess.ts";
import { inProcessWorkerServedForTests } from "./workers/inProcessWorker.ts";
import { resolveReadableWorktreeRow } from "./worktrees/knowledgeCheckout.ts";

vi.mock("./directFileGrants.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./directFileGrants.ts")>();
  return { ...actual, mintDocumentGrantOn: vi.fn(actual.mintDocumentGrantOn) };
});
vi.mock("./servedFileAccess.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./servedFileAccess.ts")>();
  return { ...actual, servedSideOf: vi.fn(actual.servedSideOf) };
});

const WORKTREE_ID = "4f1c2b9e-5d8a-4e7b-9c3f-2a1b0c9d8e7f";
let kbFile: string;
let worktreePath: string;
let dependencies: DocumentGrantResolverDependencies;

beforeAll(async () => {
  const store = new KnowledgeBaseStore();
  await store.ensureInitialized();
  kbFile = join(store.root, "report.html");
  writeFileSync(kbFile, "<p>kb</p>");
  worktreePath = mkdtempSync(join(realpathSync(tmpdir()), "grant-sides-"));
  writeFileSync(join(worktreePath, "page.html"), "<p>worktree</p>");
  const artifacts = join(DATA_DIR, "session-artifacts", "session-1");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "note.html"), "<p>artifact</p>");
  const worktree: WorktreeRow = {
    id: WORKTREE_ID,
    projectId: "project-1",
    path: worktreePath,
    mainRepoRoot: worktreePath,
    branch: "main",
    baseBranch: "main",
    baseCommit: "",
    status: "active",
    mergeStateJson: null,
    branchCleanupOid: null,
    createdAt: 1,
    updatedAt: 1,
    removedAt: null,
  };
  dependencies = {
    dataDir: DATA_DIR,
    resolveWorktree: async (id) =>
      id === WORKTREE_ID ? worktree : resolveReadableWorktreeRow(id),
  };
});

afterEach(() => vi.clearAllMocks());

function fileRequest(
  target: MintFileGrantRequest["target"],
): MintFileGrantRequest {
  return { target, scope: "file", delivery: "attachment" };
}

/** The mint's answer, the side it was minted on and its Worker requests. */
async function mint(target: MintFileGrantRequest["target"]) {
  const before = inProcessWorkerServedForTests();
  const minted = await mintDocumentTargetGrant(
    fileRequest(target),
    dependencies,
  );
  const requests = inProcessWorkerServedForTests() - before;
  expect(mintDocumentGrantOn).toHaveBeenCalledTimes(1);
  const authority = vi.mocked(mintDocumentGrantOn).mock.calls[0]![3];
  return { minted, side: authority.side, requests };
}

test("a Knowledge Base file is granted on the server by kind, without the Worker", async () => {
  const { minted, side, requests } = await mint({
    kind: "worktreeFile",
    worktreeId: KNOWLEDGE_WORKTREE_ID,
    path: "report.html",
    view: "file",
  });
  assert.equal(side, "server");
  assert.equal(requests, 0);
  assert.equal(minted.documentPath, realpathSync(kbFile));
  // The side came from the row, not from the path rule.
  expect(servedSideOf).not.toHaveBeenCalled();
});

test("a Knowledge Base attachment path resolves on the server", async () => {
  const before = inProcessWorkerServedForTests();
  const path = await resolveDocumentTargetPath({
    kind: "worktreeFile",
    worktreeId: KNOWLEDGE_WORKTREE_ID,
    path: "report.html",
    view: "file",
  });
  assert.equal(path, realpathSync(kbFile));
  assert.equal(inProcessWorkerServedForTests() - before, 0);
});

test("any other worktree's file is granted where its path is placed: the default Worker", async () => {
  const { minted, side, requests } = await mint({
    kind: "worktreeFile",
    worktreeId: WORKTREE_ID,
    path: "page.html",
    view: "file",
  });
  assert.deepEqual(side, { workerId: "local" });
  assert.ok(requests > 0, "read on the Worker");
  assert.equal(minted.documentPath, join(worktreePath, "page.html"));
  expect(servedSideOf).toHaveBeenCalled();
});

test("session artifacts stay on the server by kind", async () => {
  const { side, requests } = await mint({
    kind: "sessionArtifact",
    sessionId: "session-1",
    path: "note.html",
  });
  assert.equal(side, "server");
  assert.equal(requests, 0);
  expect(servedSideOf).not.toHaveBeenCalled();
});

test("the served adapters require a side", () => {
  // Compile-time only: never called.
  const omitted = () => {
    // @ts-expect-error a served call through the adapter must name its side
    void realpathServedFileOn("/x");
    const authority = { root: "/", sourceKey: "host" };
    // @ts-expect-error a mint through the adapter must name its side
    void mintDocumentGrantOn("/x", "file", "inline", authority);
  };
  assert.equal(typeof omitted, "function");
});
