import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, test, vi } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "placement-direct-reader-"));
const savedMode = process.env.ASSISTANT_SPAWN_BROKER;
afterEach(() => {
  vi.restoreAllMocks();
  if (savedMode === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
  else process.env.ASSISTANT_SPAWN_BROKER = savedMode;
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const mode of ["broker", "in-process"]) {
  describe(mode, () => {
    for (const reader of ["knowledgeBaseRoot", "getSettings"]) {
      test(`a direct ${reader} read seeds history before the first served placement call`, async () => {
        // Existing module-isolation seam, not a production history-reset API.
        vi.resetModules();
        process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
        const warning = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined);
        const { APP_SETTINGS_PATH } = await import("../appSettingsFile.ts");
        const kb = await import("../knowledgeBaseSettings.ts");
        const { getSettings } = await import("../settings.ts");
        const dir = join(scratch, mode, reader);
        const real = join(dir, "real");
        const alias = join(dir, "alias");
        const outside = join(dir, "checkout");
        mkdirSync(real, { recursive: true });
        mkdirSync(outside);
        mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
        symlinkSync(real, alias);
        let ownsSettings = false;
        const settings = (text: string) => {
          if (!ownsSettings) {
            // Fail without touching any pre-existing settings file or symlink.
            writeFileSync(APP_SETTINGS_PATH, text, { flag: "wx" });
            ownsSettings = true;
            return;
          }
          writeFileSync(`${APP_SETTINGS_PATH}.next`, text, { flag: "wx" });
          renameSync(`${APP_SETTINGS_PATH}.next`, APP_SETTINGS_PATH);
        };
        const read = () =>
          reader === "knowledgeBaseRoot"
            ? kb.knowledgeBaseRoot()
            : getSettings().knowledgeBase.effectivePath;
        const configured = (path: string) =>
          JSON.stringify({ knowledgeBase: { path } });
        try {
          settings(configured(alias));
          assert.equal(read(), alias);
          settings("{ not json");
          rmSync(alias);
          // Neither served placement nor checkout git has run in this module
          // graph.
          const { placeServedPath, DEFAULT_WORKER_ID } =
            await import("./placement.ts");
          assert.equal(
            placeServedPath(alias),
            undefined,
            "keep the reader's lexical root",
          );
          assert.equal(
            placeServedPath(real),
            undefined,
            "keep its realpath snapshot after the alias disappears",
          );
          assert.equal(warning.mock.calls.length, 1);
          // Checkout git is typed: it reads no KB setting, so the default
          // Worker's git in the KB runs there and the outage adds no warning.
          const { DEFAULT_WORKER_SIDE } = await import("./placement.ts");
          const { checkoutGitOn } = await import("../gitExec.ts");
          const { git } = checkoutGitOn(DEFAULT_WORKER_SIDE);
          const { inProcessWorkerServedForTests: served } =
            await import("./inProcessWorker.ts");
          let before = served();
          await git(["--version"], real);
          await git(["--version"], outside);
          assert.equal(served() - before, 2, "both cross the real transport");
          assert.equal(warning.mock.calls.length, 1);

          const nextReal = join(dir, "next-real");
          mkdirSync(nextReal);
          symlinkSync(nextReal, alias);
          settings(configured(alias));
          assert.equal(read(), alias);
          // Read once more with unchanged identity, so cached KB reads must
          // remember the current realpath too.
          rmSync(alias);
          symlinkSync(real, alias);
          assert.equal(read(), alias);
          settings("{ broken again");
          rmSync(alias);
          assert.equal(placeServedPath(real), undefined);
          assert.deepEqual(placeServedPath(nextReal), {
            workerId: DEFAULT_WORKER_ID,
            path: nextReal,
          });
          assert.equal(
            warning.mock.calls.length,
            2,
            "a direct successful read resets the warning episode",
          );
          before = served();
          await git(["--version"], real);
          await git(["--version"], nextReal);
          assert.equal(served() - before, 2);
          assert.equal(warning.mock.calls.length, 2);
          assert.throws(read, /Failed to read app settings/);

          // A readable configuration remains authoritative even with a missing
          // alias. Its failed realpath lookup must not erase known history for
          // a subsequent outage of that same configured lexical root.
          settings(configured(alias));
          assert.equal(read(), alias);
          assert.deepEqual(placeServedPath(real), {
            workerId: DEFAULT_WORKER_ID,
            path: real,
          });
          settings("{ third outage");
          assert.equal(placeServedPath(real), undefined);
          assert.equal(warning.mock.calls.length, 3);
          before = served();
          await git(["--version"], real);
          assert.equal(served() - before, 1);
        } finally {
          if (ownsSettings) rmSync(APP_SETTINGS_PATH, { force: true });
        }
      });
    }
  });
}
