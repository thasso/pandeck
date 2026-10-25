import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";
import {
  APP_SETTINGS_PATH,
  readStoredAppSettings,
} from "../appSettingsFile.ts";
import { git } from "../gitExec.ts";
import { knowledgeBaseSettingsProjection } from "../knowledgeBaseSettings.ts";
import { inProcessWorkerServedForTests } from "./inProcessWorker.ts";
import { DEFAULT_WORKER_ID, placeGitCwd } from "./placement.ts";

const scratch = mkdtempSync(join(tmpdir(), "placement-fallback-"));
const defaultRoot = knowledgeBaseSettingsProjection(undefined).effectivePath;
mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
const savedMode = process.env.ASSISTANT_SPAWN_BROKER;
let ownsDefaultLink = false;
let ownsSettings = false;
function settings(text: string): void {
  if (!ownsSettings) {
    // Exclusive creation refuses any pre-existing settings file or symlink.
    writeFileSync(APP_SETTINGS_PATH, text, { flag: "wx" });
    ownsSettings = true;
    return;
  }
  const next = `${APP_SETTINGS_PATH}.next`;
  writeFileSync(next, text, { flag: "wx" });
  renameSync(next, APP_SETTINGS_PATH);
}
const configured = (path: string) =>
  JSON.stringify({ knowledgeBase: { path } });
const onWorker = (path: string) => ({ workerId: DEFAULT_WORKER_ID, path });

afterEach(() => {
  vi.restoreAllMocks();
  if (savedMode === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
  else process.env.ASSISTANT_SPAWN_BROKER = savedMode;
  if (ownsSettings) {
    rmSync(APP_SETTINGS_PATH, { force: true });
    ownsSettings = false;
  }
  if (ownsDefaultLink) {
    // Never remove a pre-existing default KB if link creation failed.
    unlinkSync(defaultRoot);
    ownsDefaultLink = false;
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const mode of ["broker", "in-process"]) {
  describe(mode, () => {
    test("known and default KB aliases stay local through settings failure and recovery", async () => {
      process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const real = join(scratch, mode, "real-notes");
      const alias = join(scratch, mode, "notes");
      const defaultReal = join(scratch, mode, "default-notes");
      const other = join(scratch, mode, "checkout");
      for (const dir of [real, defaultReal, other])
        mkdirSync(join(dir, "sub"), { recursive: true });
      symlinkSync(real, alias);
      symlinkSync(defaultReal, defaultRoot);
      ownsDefaultLink = true;
      settings(configured(alias));
      assert.equal(
        placeGitCwd(alias),
        undefined,
        "remember a successful root and its real path",
      );
      assert.deepEqual(
        placeGitCwd(defaultReal),
        onWorker(defaultReal),
        "readable custom settings are authoritative",
      );
      settings("{ not json");
      for (const cwd of [alias, real, defaultRoot, defaultReal]) {
        assert.equal(placeGitCwd(cwd), undefined, cwd);
        assert.equal(placeGitCwd(`${cwd}/sub/../sub`), undefined);
        assert.equal(
          placeGitCwd(join(cwd, "not-created", "nested")),
          undefined,
        );
        const before = inProcessWorkerServedForTests();
        assert.match((await git(["--version"], cwd)).stdout, /^git version/);
        assert.equal(
          inProcessWorkerServedForTests(),
          before,
          `${cwd} never reaches the Worker`,
        );
      }
      assert.equal(
        warning.mock.calls.length,
        1,
        "one warning for all fallback calls",
      );
      assert.throws(
        () => readStoredAppSettings(),
        /Failed to read app settings/,
      );
      for (const cwd of [other, `${alias}-old`, `${defaultRoot}-old`])
        assert.deepEqual(placeGitCwd(cwd), onWorker(cwd));
      let before = inProcessWorkerServedForTests();
      await git(["--version"], other);
      assert.equal(
        inProcessWorkerServedForTests() - before,
        1,
        "unrelated checkout still crosses the transport",
      );

      rmSync(alias);
      unlinkSync(defaultRoot);
      ownsDefaultLink = false;
      assert.equal(
        placeGitCwd(real),
        undefined,
        "retain the known real path when its alias disappears",
      );
      assert.equal(
        placeGitCwd(defaultReal),
        undefined,
        "retain the observed default real path too",
      );
      settings("{ still broken");
      assert.equal(placeGitCwd(real), undefined);
      assert.equal(
        warning.mock.calls.length,
        1,
        "changing the error does not start a new episode",
      );

      const replacement = join(scratch, mode, "replacement");
      mkdirSync(replacement);
      settings(configured(replacement));
      assert.equal(placeGitCwd(replacement), undefined);
      for (const cwd of [alias, real, defaultRoot, defaultReal])
        assert.deepEqual(
          placeGitCwd(cwd),
          onWorker(cwd),
          "do not keep obsolete roots when settings are readable",
        );
      before = inProcessWorkerServedForTests();
      await git(["--version"], real);
      await git(["--version"], replacement);
      assert.equal(
        inProcessWorkerServedForTests() - before,
        1,
        "only the obsolete root reaches the Worker",
      );

      settings("{ broken again");
      assert.equal(
        placeGitCwd(replacement),
        undefined,
        "a failed read cannot poison the new last-successful root",
      );
      assert.equal(placeGitCwd(defaultReal), undefined);
      assert.deepEqual(
        placeGitCwd(real),
        onWorker(real),
        "failure retains only the most recent custom root",
      );
      assert.equal(warning.mock.calls.length, 2);
      const missing = join(scratch, mode, "not-created");
      settings(configured(missing));
      assert.equal(placeGitCwd(join(missing, "nested")), undefined);
      settings("{ broken once more");
      assert.equal(
        placeGitCwd(join(missing, "nested")),
        undefined,
        "a nonexistent root still matches lexically",
      );
      assert.equal(warning.mock.calls.length, 3);
    });

    test("fallback warning resets after any successful settings read", async () => {
      process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const outside = join(scratch, mode, "warning-checkout");
      mkdirSync(outside, { recursive: true });
      settings("{}");
      assert.deepEqual(placeGitCwd(outside), onWorker(outside));
      settings("{ not json");
      for (let i = 0; i < 3; i++) await git(["--version"], outside);
      assert.equal(warning.mock.calls.length, 1);
      assert.match(
        String(warning.mock.calls[0]?.[0]),
        /Knowledge Base.*settings/i,
      );
      assert.ok(
        !String(warning.mock.calls[0]?.[0]).includes(APP_SETTINGS_PATH),
        "do not log raw settings paths/errors",
      );
      settings("{}");
      await git(["--version"], outside);
      settings("{ not json");
      for (let i = 0; i < 3; i++) await git(["--version"], outside);
      assert.equal(warning.mock.calls.length, 2);
    });
  });
}
