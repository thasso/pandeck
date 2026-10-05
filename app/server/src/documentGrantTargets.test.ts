import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  handleFileGrantRequest,
  resetFileGrantsForTest,
} from "./directFileGrants.ts";
import {
  mintDocumentTargetGrant,
  parseMintFileGrantRequest,
  type DocumentGrantResolverDependencies,
} from "./documentGrantTargets.ts";

let server: Server;
let origin: string;
let root: string;
let dataDir: string;
let worktreeRoot: string;
let dependencies: DocumentGrantResolverDependencies;

function htmlPair(directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "page.html"),
    '<script src="./app.js"></script>',
  );
  writeFileSync(join(directory, "app.js"), "globalThis.loaded = true;\n");
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pa-document-grants-"));
  dataDir = join(root, "data");
  worktreeRoot = join(root, "worktree");
  htmlPair(join(root, "host"));
  htmlPair(join(dataDir, "session-artifacts", "session-1", "report"));
  htmlPair(join(worktreeRoot, "site"));
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "secret.txt"), "SECRET");
  for (const directory of [
    join(root, "host"),
    join(dataDir, "session-artifacts", "session-1", "report"),
    join(worktreeRoot, "site"),
  ]) {
    symlinkSync(join(elsewhere, "secret.txt"), join(directory, "escape.txt"));
    writeFileSync(join(directory, "notes.txt"), "not html");
    symlinkSync(join(directory, "notes.txt"), join(directory, "pretend.html"));
  }
  symlinkSync(
    join(dataDir, "session-artifacts", "session-1"),
    join(dataDir, "session-artifacts", "session-alias"),
  );
  dependencies = {
    dataDir,
    resolveWorktree: async (id) =>
      id === "worktree-1"
        ? {
            id,
            projectId: "project-1",
            path: worktreeRoot,
            mainRepoRoot: worktreeRoot,
            branch: "test",
            baseBranch: "main",
            baseCommit: "abc",
            status: "active",
            mergeStateJson: null,
            branchCleanupOid: null,
            createdAt: 1,
            updatedAt: 1,
            removedAt: null,
          }
        : undefined,
  };

  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleFileGrantRequest(req, res, url);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  resetFileGrantsForTest();
  await new Promise<void>((done) => server.close(() => done()));
});

const sources = [
  {
    label: "host",
    target: () => ({
      kind: "hostFile" as const,
      path: join(root, "host", "page.html"),
    }),
  },
  {
    label: "artifact",
    target: () => ({
      kind: "sessionArtifact" as const,
      sessionId: "session-1",
      path: "report/page.html",
    }),
  },
  {
    label: "worktree",
    target: () => ({
      kind: "worktreeFile" as const,
      worktreeId: "worktree-1",
      path: "site/page.html",
      view: "file" as const,
    }),
  },
] as const;

describe("typed document grants", () => {
  for (const source of sources) {
    test(`${source.label} HTML gets only its source directory and siblings`, async () => {
      const grant = await mintDocumentTargetGrant(
        {
          target: source.target(),
          scope: "directory",
          delivery: "inline",
        },
        dependencies,
      );
      const document = await fetch(`${origin}${grant.url}`);
      assert.equal(document.status, 200);
      assert.equal(
        document.headers.get("content-type"),
        "text/html; charset=utf-8",
      );
      assert.doesNotMatch(
        document.headers.get("content-security-policy") ?? "",
        /allow-same-origin/,
      );
      const sibling = await fetch(
        `${origin}/api/file-grants/${grant.grantId}/app.js`,
      );
      assert.equal(sibling.status, 200);
      assert.equal(sibling.headers.get("x-content-type-options"), "nosniff");
      const escape = await fetch(
        `${origin}/api/file-grants/${grant.grantId}/..%2Foutside.txt`,
      );
      assert.equal(escape.status, 404);
      const symlinkEscape = await fetch(
        `${origin}/api/file-grants/${grant.grantId}/escape.txt`,
      );
      assert.equal(symlinkEscape.status, 404);

      const fileGrant = await mintDocumentTargetGrant(
        { target: source.target(), scope: "file", delivery: "inline" },
        dependencies,
      );
      const refusedSibling = await fetch(
        `${origin}/api/file-grants/${fileGrant.grantId}/app.js`,
      );
      assert.equal(refusedSibling.status, 404);
    });
  }

  test("canonical non-HTML aliases never acquire directory authority", async () => {
    const aliases = [
      {
        kind: "hostFile" as const,
        path: join(root, "host", "pretend.html"),
      },
      {
        kind: "sessionArtifact" as const,
        sessionId: "session-1",
        path: "report/pretend.html",
      },
      {
        kind: "worktreeFile" as const,
        worktreeId: "worktree-1",
        path: "site/pretend.html",
        view: "file" as const,
      },
    ];
    for (const target of aliases)
      await assert.rejects(
        mintDocumentTargetGrant(
          { target, scope: "directory", delivery: "inline" },
          dependencies,
        ),
        /canonical HTML|symlink/i,
      );
  });

  test("source identity prevents reuse across authorities over the same file", async () => {
    const path = join(worktreeRoot, "site", "page.html");
    const host = await mintDocumentTargetGrant(
      {
        target: { kind: "hostFile", path },
        scope: "directory",
        delivery: "inline",
      },
      dependencies,
    );
    const worktree = await mintDocumentTargetGrant(
      {
        target: {
          kind: "worktreeFile",
          worktreeId: "worktree-1",
          path: "site/page.html",
          view: "file",
        },
        scope: "directory",
        delivery: "inline",
      },
      dependencies,
    );
    assert.notEqual(host.grantId, worktree.grantId);
  });

  test("rejects client paths and aliased roots that escape typed sources", async () => {
    await assert.rejects(
      mintDocumentTargetGrant(
        {
          target: {
            kind: "sessionArtifact",
            sessionId: "session-alias",
            path: "report/page.html",
          },
          scope: "directory",
          delivery: "inline",
        },
        dependencies,
      ),
      /root escapes/,
    );
    await assert.rejects(
      mintDocumentTargetGrant(
        {
          target: {
            kind: "sessionArtifact",
            sessionId: "..\\session-2",
            path: "report/page.html",
          },
          scope: "directory",
          delivery: "inline",
        },
        dependencies,
      ),
      /Invalid session id/,
    );
    await assert.rejects(
      mintDocumentTargetGrant(
        {
          target: {
            kind: "sessionArtifact",
            sessionId: "session-1",
            path: "../session-2/page.html",
          },
          scope: "directory",
          delivery: "inline",
        },
        dependencies,
      ),
      /Invalid document path/,
    );
    await assert.rejects(
      mintDocumentTargetGrant(
        {
          target: {
            kind: "worktreeFile",
            worktreeId: "worktree-1",
            path: "../host/page.html",
            view: "file",
          },
          scope: "directory",
          delivery: "inline",
        },
        dependencies,
      ),
      /Invalid file path/,
    );
  });

  test("wire validation enforces minimum scope and ignores resolved paths", () => {
    assert.deepEqual(
      parseMintFileGrantRequest({
        target: {
          kind: "sessionArtifact",
          sessionId: "session-1",
          path: "report/page.html",
          resolvedPath: "/etc/passwd",
        },
        scope: "directory",
        delivery: "inline",
      }),
      {
        target: {
          kind: "sessionArtifact",
          sessionId: "session-1",
          path: "report/page.html",
        },
        scope: "directory",
        delivery: "inline",
      },
    );
    assert.equal(
      parseMintFileGrantRequest({
        target: { kind: "hostFile", path: "/tmp/report.pdf" },
        scope: "file",
        delivery: "inline",
        fresh: true,
      }).fresh,
      true,
    );
    assert.throws(
      () =>
        parseMintFileGrantRequest({
          target: { kind: "hostFile", path: "/tmp/report.pdf" },
          scope: "file",
          delivery: "inline",
          fresh: false,
        }),
      /freshness/,
    );
    assert.throws(
      () =>
        parseMintFileGrantRequest({
          target: { kind: "sessionArtifact", sessionId: "s", path: "notes.md" },
          scope: "directory",
          delivery: "inline",
        }),
      /only for runnable HTML/,
    );
  });
});
