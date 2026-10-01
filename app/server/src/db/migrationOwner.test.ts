import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  assertMayApplyMigrations,
  isPackagedBuild,
  readMigrationOwner,
  recordMigrationOwner,
} from "./migrationOwner.ts";

const PACKAGED = "/nix/store/abc123-personal-assistant-0.9.0/libexec/pa";
const WORKING_COPY = "/home/alice/projects/assistant";

function ownerPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "migration-owner-")),
    ".migration-owner.json",
  );
}

afterEach(() => {
  delete process.env.ASSISTANT_ALLOW_FOREIGN_MIGRATIONS;
});

test("only a Nix store path counts as a packaged build", () => {
  assert.equal(isPackagedBuild(PACKAGED), true);
  assert.equal(isPackagedBuild(WORKING_COPY), false);
});

test("a working copy may not migrate a packaged deployment's data", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);

  assert.throws(
    () =>
      assertMayApplyMigrations(["0042_project_revision.sql"], {
        path,
        appRoot: WORKING_COPY,
      }),
    /owned by the packaged build/,
  );
});

test("a release migrating its own deployment is the normal path", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);

  // A later release has a different store path; that must not read as foreign.
  assertMayApplyMigrations(["0046_next.sql"], {
    path,
    appRoot: "/nix/store/def456-personal-assistant-0.10.0/libexec/pa",
  });
});

test("an unowned or dev-owned data directory is unrestricted", () => {
  const fresh = ownerPath();
  assertMayApplyMigrations(["0042_project_revision.sql"], {
    path: fresh,
    appRoot: WORKING_COPY,
  });

  const devOwned = ownerPath();
  recordMigrationOwner(devOwned, WORKING_COPY);
  assertMayApplyMigrations(["0042_project_revision.sql"], {
    path: devOwned,
    appRoot: WORKING_COPY,
  });
});

test("nothing pending is never refused, so reads from a checkout still work", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);
  assertMayApplyMigrations([], { path, appRoot: WORKING_COPY });
});

test("the override allows a deliberate out-of-band repair", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);
  process.env.ASSISTANT_ALLOW_FOREIGN_MIGRATIONS = "1";

  assertMayApplyMigrations(["0042_project_revision.sql"], {
    path,
    appRoot: WORKING_COPY,
  });
});

test("a working copy never downgrades a packaged owner", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);

  recordMigrationOwner(path, WORKING_COPY);

  const owner = readMigrationOwner(path);
  assert.equal(owner?.packaged, true);
  assert.equal(owner?.appRoot, PACKAGED);
});

test("a packaged build claims a directory a working copy owned", () => {
  const path = ownerPath();
  recordMigrationOwner(path, WORKING_COPY);

  recordMigrationOwner(path, PACKAGED);

  assert.equal(readMigrationOwner(path)?.appRoot, PACKAGED);
});

test("a malformed marker reads as absent rather than throwing", () => {
  const path = ownerPath();
  writeFileSync(path, "{not json", "utf8");

  assert.equal(readMigrationOwner(path), undefined);
  assertMayApplyMigrations(["0042_project_revision.sql"], {
    path,
    appRoot: WORKING_COPY,
  });
});

test("the marker is human-readable JSON", () => {
  const path = ownerPath();
  recordMigrationOwner(path, PACKAGED);

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(parsed.packaged, true);
  assert.equal(parsed.appRoot, PACKAGED);
  assert.equal(typeof parsed.updatedAtMs, "number");
});
