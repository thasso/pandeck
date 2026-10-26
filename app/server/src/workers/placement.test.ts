import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "worker-placement-test-"));
process.env.ASSISTANT_CWD = tmp;

const { updateSettings } = await import("../settings.ts");
const { DEFAULT_WORKER_ID, placeGitCwd } = await import("./placement.ts");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const onWorker = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

test("git inside the Knowledge Base stays on the server, by name or by real path", () => {
  const real = join(tmp, "real", "notes");
  mkdirSync(join(real, "sub"), { recursive: true });
  const link = join(tmp, "notes");
  symlinkSync(real, link);
  updateSettings({
    knowledgeBase: { enabled: true, path: link, effectivePath: "ignored" },
  });

  for (const inside of [
    link,
    `${link}/`,
    join(link, "sub"),
    `${link}/sub/../sub`,
    real,
    join(real, "sub"),
    // Not created: containment is a path question, not a lookup.
    join(link, "missing", "deeper"),
  ])
    assert.equal(placeGitCwd(inside), undefined, inside);

  for (const outside of [
    join(tmp, "notes-old"),
    join(tmp, "real", "notes-old"),
    join(tmp, "real"),
    tmp,
    `${link}/..`,
    "/",
  ])
    assert.deepEqual(placeGitCwd(outside), onWorker(outside), outside);
});

test("a Knowledge Base folder not created yet still keeps its own path local", () => {
  const missing = join(tmp, "later");
  updateSettings({
    knowledgeBase: { enabled: true, path: missing, effectivePath: "ignored" },
  });
  assert.equal(placeGitCwd(join(missing, "x")), undefined);
  assert.deepEqual(
    placeGitCwd(join(tmp, "later-old")),
    onWorker(join(tmp, "later-old")),
  );
});
