import { describe, expect, it } from "vitest";
import {
  buildCommitLabel,
  buildVersionLabel,
  formatBuildInfo,
  shortCommit,
} from "./buildInfo.ts";

/**
 * How a build names itself. Every About surface — the desktop app's native panel,
 * Settings → About, a copied diagnostic — goes through these, so the rules live
 * here: the `-dev` suffix is a claim ("this is NOT the tagged release") and must
 * never be made on the strength of an unknown, and an unknown commit is dropped
 * rather than rendered as a placeholder.
 */
describe("build labels", () => {
  const commit = "88b944c8acdd03bb70c1f6cca7f9b3086de68b66";

  it("names a release by its version alone", () => {
    const info = { version: "0.14.1", commit, release: true };
    expect(buildVersionLabel(info)).toBe("0.14.1");
    expect(formatBuildInfo(info)).toBe("0.14.1 (88b944c8)");
  });

  it("marks a build known to be ahead of its tag", () => {
    expect(formatBuildInfo({ version: "0.14.1", commit, release: false })).toBe(
      "0.14.1-dev (88b944c8)",
    );
  });

  it("says nothing extra when release-ness is unknown", () => {
    // The packaged build: it knows its commit but never its tags, so claiming
    // either "release" or "dev" would be inventing an answer.
    expect(formatBuildInfo({ version: "0.14.1", commit })).toBe(
      "0.14.1 (88b944c8)",
    );
  });

  it("marks a modified tree on the commit, where the modification is", () => {
    expect(buildCommitLabel({ version: "0.14.1", commit, dirty: true })).toBe(
      "88b944c8-dirty",
    );
  });

  it("drops an unknown commit instead of faking one", () => {
    expect(shortCommit(undefined)).toBe(undefined);
    expect(buildCommitLabel({ version: "0.14.1" })).toBe(undefined);
    expect(formatBuildInfo({ version: "0.14.1" })).toBe("0.14.1");
    expect(formatBuildInfo({ version: "0.14.1", release: false })).toBe(
      "0.14.1-dev",
    );
  });
});
