import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "kb-settings-test-"));
process.env.ASSISTANT_CWD = tmp;

const { DATA_DIR } = await import("./config.ts");
const { getSettings, updateSettings } = await import("./settings.ts");
const {
  knowledgeBaseEnabled,
  knowledgeBaseRoot,
  knowledgeBaseSettingsProjection,
} = await import("./knowledgeBaseSettings.ts");
const { KnowledgeBaseStore } = await import("./knowledgeBaseStore.ts");
const { resolveReadableWorktreeRow } =
  await import("./worktrees/knowledgeCheckout.ts");
const { resolvePaObjectLinks } = await import("./objectLinkResolver.ts");
const { currentIntegrationToolGates } = await import("./tools/toolPolicy.ts");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("is on by default, in the data folder", () => {
  assert.deepEqual(getSettings().knowledgeBase, {
    enabled: true,
    path: "",
    effectivePath: join(DATA_DIR, "knowledge"),
  });
  assert.equal(knowledgeBaseEnabled(), true);
  assert.equal(new KnowledgeBaseStore().root, join(DATA_DIR, "knowledge"));
});

test("resolves a configured folder: absolute, home-relative, or under the data folder", () => {
  const folder = (path: string) =>
    knowledgeBaseSettingsProjection({ path }).effectivePath;
  assert.equal(folder("/srv/notes/"), "/srv/notes");
  assert.equal(folder("~/notes"), join(homedir(), "notes"));
  assert.equal(folder("notes"), join(DATA_DIR, "notes"));
  assert.equal(folder("  "), join(DATA_DIR, "knowledge"));
});

test("a saved folder is where the store, and the checkout, read from", async () => {
  const folder = join(tmp, "my-notes");
  updateSettings({
    knowledgeBase: { enabled: true, path: folder, effectivePath: "ignored" },
  });
  assert.equal(getSettings().knowledgeBase.effectivePath, folder);
  assert.equal(knowledgeBaseRoot(), folder);
  const row = await resolveReadableWorktreeRow("knowledge");
  assert.equal(row?.path, folder, "the folder was made a repository");
});

test("off, nothing offers the Knowledge Base", async () => {
  updateSettings({
    knowledgeBase: { enabled: false, path: "kept", effectivePath: "" },
  });
  assert.equal(currentIntegrationToolGates().knowledgeBase, false);
  assert.equal(await resolveReadableWorktreeRow("knowledge"), undefined);
  const [link] = await resolvePaObjectLinks(["pa://knowledge/notes.md"]);
  assert.equal(link?.existence, "unknown");
  // A patch naming one field keeps the other.
  updateSettings({
    knowledgeBase: { enabled: true } as never,
  });
  assert.deepEqual(getSettings().knowledgeBase, {
    enabled: true,
    path: "kept",
    effectivePath: join(DATA_DIR, "kept"),
  });
});
