import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, test } from "vitest";
import {
  APP_SETTINGS_PATH,
  readStoredAppSettings,
} from "../appSettingsFile.ts";
import { DATA_DIR } from "../config.ts";
import * as checkout from "../gitExec.ts";
import { createGitFamily } from "../gitFamily.ts";
import { localGitRunner } from "../gitProcess.ts";
import { knowledgeBaseRoot } from "../knowledgeBaseSettings.ts";
import * as serverLocal from "../serverRepoGit.ts";
import { getSettings } from "../settings.ts";
import { inProcessWorkerServedForTests } from "./inProcessWorker.ts";
import { DEFAULT_WORKER_ID, placeGitCwd } from "./placement.ts";

const local = createGitFamily(localGitRunner);
const scratch = mkdtempSync(join(tmpdir(), "placement-settings-"));
const repo = join(scratch, "repo");
mkdirSync(repo);
mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });

/** Atomic replacement also tests the settings cache's inode revalidation. */
function settings(text: string): void {
  const next = `${APP_SETTINGS_PATH}.next`;
  writeFileSync(next, text);
  renameSync(next, APP_SETTINGS_PATH);
}

const savedMode = process.env.ASSISTANT_SPAWN_BROKER;
afterEach(() => {
  process.env.ASSISTANT_SPAWN_BROKER = savedMode;
  if (savedMode === undefined) delete process.env.ASSISTANT_SPAWN_BROKER;
  rmSync(APP_SETTINGS_PATH, { recursive: true, force: true });
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const onWorker = { workerId: DEFAULT_WORKER_ID, path: repo };

for (const mode of ["broker", "in-process"]) {
  describe(mode, () => {
    for (const fault of ["invalid JSON", "unreadable directory", "EACCES"]) {
      test.skipIf(fault === "EACCES" && process.getuid?.() === 0)(
        `unavailable KB settings (${fault}) do not break unrelated checkout git`,
        async () => {
          process.env.ASSISTANT_SPAWN_BROKER = mode === "broker" ? "1" : "0";
          const custom = join(scratch, "custom-notes");
          mkdirSync(custom, { recursive: true });
          const valid = JSON.stringify({ knowledgeBase: { path: custom } });
          settings(valid);
          assert.equal(knowledgeBaseRoot(), custom, "prime the settings cache");
          assert.equal(placeGitCwd(custom), undefined);
          await local.git(["init", "-q"], repo);

          try {
            if (fault === "invalid JSON") settings("{ not json");
            else if (fault === "unreadable directory") {
              rmSync(APP_SETTINGS_PATH);
              mkdirSync(APP_SETTINGS_PATH);
            } else {
              settings(valid);
              chmodSync(APP_SETTINGS_PATH, 0o000);
            }
            assert.throws(
              () => readStoredAppSettings(),
              /Failed to read app settings/,
            );
            assert.throws(() => getSettings(), /Failed to read app settings/);
            assert.throws(
              () => knowledgeBaseRoot(),
              /Failed to read app settings/,
            );
            assert.deepEqual(placeGitCwd(repo), onWorker);

            const before = inProcessWorkerServedForTests();
            const success = ["rev-parse", "--git-dir"];
            assert.deepEqual(
              await checkout.git(success, repo),
              await local.git(success, repo),
            );
            assert.deepEqual(
              await checkout.gitOptional(success, repo),
              await local.gitOptional(success, repo),
            );
            assert.deepEqual(
              await checkout.gitRawStdout(success, repo),
              await local.gitRawStdout(success, repo),
            );
            assert.deepEqual(
              await checkout.gitBoundedStdout(success, repo, 3),
              await local.gitBoundedStdout(success, repo, 3),
            );

            const failed = ["rev-parse", "--verify", "refs/heads/missing"];
            assert.deepEqual(
              await checkout.gitOptional(failed, repo),
              await local.gitOptional(failed, repo),
            );
            assert.deepEqual(
              await checkout.gitRawStdout(failed, repo),
              await local.gitRawStdout(failed, repo),
            );
            for (const run of [
              () => checkout.git(failed, repo),
              () => checkout.gitBoundedStdout(failed, repo, 3),
            ]) {
              await assert.rejects(run, (error: unknown) => {
                assert.ok(error instanceof checkout.GitCommandError);
                assert.equal(
                  error.failureKind,
                  "exit",
                  "the git failure, not a settings execution error",
                );
                return true;
              });
            }
            assert.equal(
              inProcessWorkerServedForTests() - before,
              8,
              "all calls cross the real Worker transport",
            );
            assert.throws(
              () => readStoredAppSettings(),
              /Failed to read app settings/,
            );
          } finally {
            rmSync(APP_SETTINGS_PATH, { recursive: true, force: true });
            settings(valid);
          }
          assert.equal(
            knowledgeBaseRoot(),
            custom,
            "repair recovers without invalidating the cache manually",
          );
          assert.equal(
            placeGitCwd(custom),
            undefined,
            "the recovered KB stays local",
          );
          assert.deepEqual(placeGitCwd(repo), onWorker);
          const beforeLocal = inProcessWorkerServedForTests();
          assert.equal(
            (await checkout.gitOptional(["--version"], custom)).code,
            0,
          );
          assert.equal(
            (await serverLocal.gitOptional(["--version"], repo)).code,
            0,
          );
          assert.equal(
            inProcessWorkerServedForTests(),
            beforeLocal,
            "B6 local family is unchanged",
          );

          rmSync(APP_SETTINGS_PATH);
          assert.equal(knowledgeBaseRoot(), join(DATA_DIR, "knowledge"));
          assert.equal(
            placeGitCwd(join(DATA_DIR, "knowledge", "missing")),
            undefined,
          );
          assert.deepEqual(placeGitCwd(repo), onWorker);
        },
      );
    }
  });
}
