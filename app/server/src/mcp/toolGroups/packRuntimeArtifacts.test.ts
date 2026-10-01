import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { DATA_DIR } from "../../config.ts";
import {
  deleteSessionArtifacts,
  listSessionArtifacts,
  sessionArtifactFile,
  stageSessionArtifact,
  stageSessionArtifactFile,
} from "./packRuntime.ts";

const sessions: string[] = [];

function artifactPath(url: string): string {
  const pathname = new URL(url, "http://localhost").pathname;
  const relative = pathname.slice("/api/session-artifacts/".length);
  return join(
    DATA_DIR,
    "session-artifacts",
    ...relative.split("/").map(decodeURIComponent),
  );
}

function stage(sessionId: string, name: string) {
  return stageSessionArtifact(sessionId, {
    name,
    mimeType: "application/octet-stream",
    bytes: Uint8Array.of(1),
    kind: "file",
    label: name,
    sourceTool: "test",
    directory: "files",
  });
}

afterEach(() => {
  for (const sessionId of sessions.splice(0)) deleteSessionArtifacts(sessionId);
});

describe("staged session artifacts", () => {
  test("rejects artifact directories that collapse to the session root or its parent", () => {
    const sessionId = "artifact-directory-guard";
    sessions.push(sessionId);
    for (const directory of [".", ".."]) {
      assert.throws(
        () =>
          stageSessionArtifact(sessionId, {
            name: "file.bin",
            mimeType: "application/octet-stream",
            bytes: Uint8Array.of(1),
            kind: "file",
            label: "file",
            sourceTool: "test",
            directory,
          }),
        /Invalid artifact directory/,
      );
    }
  });

  test("resolves a registered artifact to its PA-owned local file", () => {
    const sessionId = "artifact-local-file";
    sessions.push(sessionId);
    const artifact = stage(sessionId, "output.bin");

    assert.deepEqual(sessionArtifactFile(sessionId, artifact.id), {
      artifact,
      path: artifactPath(artifact.url),
    });
    assert.equal(sessionArtifactFile(sessionId, "missing"), undefined);
  });

  test("deletes artifact files when their drawer records are trimmed", () => {
    const sessionId = "artifact-trim-files";
    sessions.push(sessionId);
    const first = stage(sessionId, "first.bin");
    const firstPath = artifactPath(first.url);
    assert.equal(existsSync(firstPath), true);

    for (let index = 1; index <= 80; index += 1)
      stage(sessionId, `artifact-${index}.bin`);

    assert.equal(listSessionArtifacts(sessionId).length, 80);
    assert.equal(existsSync(firstPath), false);
  });

  test("registers nothing and keeps no file when the drawer record cannot be saved", async () => {
    const sessionId = "artifact-unsaved-record";
    sessions.push(sessionId);
    const kept = stage(sessionId, "kept.bin");
    // A directory where the side store's JSON belongs makes its write fail.
    const storePath = join(
      DATA_DIR,
      "session-tool-groups",
      `${sessionId}.json`,
    );
    rmSync(storePath, { force: true });
    mkdirSync(storePath);
    try {
      await assert.rejects(
        stageSessionArtifactFile(sessionId, {
          name: "large.bin",
          mimeType: "application/octet-stream",
          kind: "download",
          label: "large.bin",
          sourceTool: "test",
          directory: "files",
          write: (path) => writeFile(path, Uint8Array.of(1, 2, 3)),
        }),
        /EISDIR/,
      );
    } finally {
      rmSync(storePath, { recursive: true, force: true });
    }

    assert.deepEqual(
      listSessionArtifacts(sessionId).map((artifact) => artifact.id),
      [kept.id],
    );
    assert.deepEqual(
      readdirSync(join(DATA_DIR, "session-artifacts", sessionId, "files")),
      [artifactPath(kept.url).split("/").at(-1)],
    );
  });
});
