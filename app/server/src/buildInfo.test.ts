import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { resolveBuildInfo } from "./buildInfo.ts";

/**
 * What the About surfaces claim about a build, in the four situations the app is
 * actually built in: at a release tag, ahead of one, from a modified tree, and
 * from a packaged source tree with no repository at all. The tri-state `release`
 * is the point — "not the release" and "cannot tell" must not collapse into one
 * answer, because the first is a fact about a dev build and the second is all a
 * Nix build can honestly say.
 */

const roots: string[] = [];

function fixture(version: string): {
  root: string;
  git: (...a: string[]) => string;
} {
  const root = mkdtempSync(join(tmpdir(), "pa-build-info-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
  return { root, git };
}

function repository(version: string): {
  root: string;
  git: (...a: string[]) => string;
} {
  const { root, git } = fixture(version);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Build Fixture");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-qm", `Release ${version}`);
  return { root, git };
}

afterEach(() => {
  delete process.env.ASSISTANT_BUILD_COMMIT;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("resolveBuildInfo", () => {
  it("reports a tagged commit as the release it is", () => {
    const { root, git } = repository("0.3.0");
    git("tag", "v0.3.0");

    const info = resolveBuildInfo(root);

    assert.equal(info.version, "0.3.0");
    assert.equal(info.commit, git("rev-parse", "HEAD"));
    assert.equal(info.release, true);
    assert.equal(info.dirty, undefined);
  });

  it("reports an untagged commit as positively NOT the release", () => {
    const { root } = repository("0.3.0");

    // The deployed server and every local build live here: the tree declares the
    // last released version while being ahead of its tag.
    assert.equal(resolveBuildInfo(root).release, false);
  });

  it("reports a modified working tree", () => {
    const { root } = repository("0.3.0");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "0.3.0 " }),
    );

    assert.equal(resolveBuildInfo(root).dirty, true);
  });

  it("knows nothing but its version outside a repository", () => {
    const { root } = fixture("0.3.0");

    assert.deepEqual(resolveBuildInfo(root), { version: "0.3.0" });
  });

  it("takes a stamped commit as the answer and claims nothing about tags", () => {
    const { root } = fixture("0.3.0");
    const stamped = "a".repeat(40);
    process.env.ASSISTANT_BUILD_COMMIT = stamped;

    // This is the packaged (Nix) build: it knows exactly which commit it came
    // from and has no tags to consult, so `release` must stay unknown rather
    // than reading as a dev build.
    assert.deepEqual(resolveBuildInfo(root), {
      version: "0.3.0",
      commit: stamped,
    });
  });

  it("uses an explicitly captured stamp after the environment is scrubbed", () => {
    const { root } = fixture("0.3.0");
    const captured = "b".repeat(40);
    delete process.env.ASSISTANT_BUILD_COMMIT;

    assert.deepEqual(resolveBuildInfo(root, captured), {
      version: "0.3.0",
      commit: captured,
    });
  });

  it("ignores a stamp that is not a commit sha", () => {
    const { root } = fixture("0.3.0");
    for (const bad of [
      "",
      "  ",
      "HEAD",
      "v0.3.0",
      "a".repeat(39),
      "A".repeat(40),
    ]) {
      process.env.ASSISTANT_BUILD_COMMIT = bad;
      assert.deepEqual(resolveBuildInfo(root), { version: "0.3.0" }, bad);
    }
  });
});
