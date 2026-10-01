import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  jiraCachePath,
  readJsonCacheFile,
  writeJsonCacheFile,
} from "./jiraCacheFile.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("jiraCachePath keeps the shared host sanitization", () => {
  assert.match(
    jiraCachePath("https://jira.example.test/team one", "fields"),
    /cache\/jira\/fields-jira\.example\.test_team_one\.json$/,
  );
  assert.match(jiraCachePath("https://", "fields"), /fields-jira\.json$/);
});

test("JSON cache files retain atomic formatted writes and tolerant reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "jira-cache-file-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "nested", "cache.json");

  assert.equal(readJsonCacheFile(path), null);
  writeJsonCacheFile(path, { value: 1 });
  assert.deepEqual(readJsonCacheFile(path), { value: 1 });
  assert.equal(readFileSync(path, "utf8"), '{\n  "value": 1\n}\n');

  writeJsonCacheFile(path, undefined);
  assert.equal(readJsonCacheFile(path), null);
});
