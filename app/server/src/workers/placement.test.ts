import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "worker-placement-test-"));
process.env.ASSISTANT_CWD = tmp;
// `DATA_DIR` (`<cwd>/assistant-data`) is itself a link here, so its real
// spelling differs from its name.
const dataReal = join(tmp, "data-real");
mkdirSync(dataReal);
symlinkSync(dataReal, join(tmp, "assistant-data"));

const { updateSettings } = await import("../settings.ts");
const { DATA_DIR } = await import("../config.ts");
const { DEFAULT_WORKER_ID, placeGitCwd, placeServedPath } =
  await import("./placement.ts");

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

test("a served file named inside DATA_DIR stays on the server, by name or by real path", () => {
  assert.equal(DATA_DIR, join(tmp, "assistant-data"));
  for (const inside of [
    DATA_DIR,
    join(DATA_DIR, "session-artifacts", "s1", "shot.png"),
    `${DATA_DIR}/x/../y.md`,
    dataReal,
    join(dataReal, "session-artifacts", "s1", "shot.png"),
  ])
    assert.equal(placeServedPath(inside), undefined, inside);
  for (const outside of [
    `${DATA_DIR}-old/file.md`,
    join(tmp, "data-real-old", "file.md"),
    join(tmp, "file.md"),
  ])
    assert.deepEqual(placeServedPath(outside), onWorker(outside), outside);
});

test("a served file in a custom Knowledge Base stays on the server, as checkout git does", () => {
  const real = join(tmp, "served-real", "notes");
  mkdirSync(real, { recursive: true });
  const link = join(tmp, "served-notes");
  symlinkSync(real, link);
  updateSettings({
    knowledgeBase: { enabled: true, path: link, effectivePath: "ignored" },
  });
  for (const path of [
    join(link, "page.md"),
    join(real, "page.md"),
    join(link, "missing", "deeper.md"),
    join(tmp, "served-notes-old", "page.md"),
    join(tmp, "served-real", "page.md"),
  ])
    assert.deepEqual(placeServedPath(path), placeGitCwd(path), path);
  assert.equal(placeServedPath(join(real, "page.md")), undefined);
});

test("a link from outside into DATA_DIR is read by the Worker, never resolved here", () => {
  // The server never follows a requested path: a link an agent made into
  // DATA_DIR is read with the Worker's rights, not the server's.
  const outside = join(tmp, "agent-checkout");
  mkdirSync(outside, { recursive: true });
  const link = join(outside, "into-data");
  symlinkSync(dataReal, link);
  const path = join(link, ".assistant-token");
  assert.deepEqual(placeServedPath(path), onWorker(path));
  assert.deepEqual(placeServedPath(link), onWorker(link));
});
