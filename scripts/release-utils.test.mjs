import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectChanges, repositoryWebUrl } from "./generate-changelog.mjs";
import {
  assertDeclaredVersion,
  assertOnFirstParentHistory,
  assertSemVer,
  extractChangelogSection,
  findChangelogSection,
  readDeclaredVersions,
  setRepositoryVersion,
} from "./release-utils.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

test("SemVer validation accepts release versions and rejects tag names", () => {
  assert.equal(assertSemVer("0.2.0"), "0.2.0");
  assert.equal(assertSemVer("1.0.0-rc.1"), "1.0.0-rc.1");
  assert.throws(() => assertSemVer("v0.2.0"), /without a leading v/);
  assert.throws(() => assertSemVer("01.2.0"), /Invalid version/);
});

test("release notes contain exactly one requested changelog body", () => {
  const changelog = `# Changelog\n\n## [0.2.0] - 2026-08-10\n\n- New release\n\n## [0.1.0]\n\n- Old release\n`;
  assert.equal(extractChangelogSection(changelog, "0.2.0"), "- New release\n");
  assert.equal(findChangelogSection(changelog, "0.3.0"), null);
  assert.throws(
    () => extractChangelogSection(changelog, "0.3.0"),
    /has no section/,
  );
});

/** Every declaration the release gate reads, minus the shell's crate files. */
const MANIFESTS = [
  "package.json",
  "app/server/package.json",
  "app/shared/package.json",
  "app/web/package.json",
];

/** Every declaration read out of a larger file, in the order the reader returns. */
const EMBEDDED = [
  "app/shell/tauri.conf.json",
  "flake.nix",
  "app/shell/Cargo.toml",
  "app/shell/Cargo.lock",
];

/**
 * The shell's Cargo files, with a dependency version and a second crate the
 * patterns must NOT pick up — the fixture is what proves they are anchored.
 */
function writeShellFixture(root, version) {
  writeFileSync(
    join(root, "app/shell/tauri.conf.json"),
    `{\n  "productName": "Fixture",\n  "version": "${version}",\n  "bundle": {\n    "targets": "all"\n  }\n}\n`,
  );
  writeShellCargoFixture(root, version);
}

function writeShellCargoFixture(root, version) {
  writeFileSync(
    join(root, "app/shell/Cargo.toml"),
    [
      "[package]",
      'name = "personal-assistant-shell"',
      `version = "${version}"`,
      "",
      "[dependencies]",
      'tauri = { version = "2", features = [] }',
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "app/shell/Cargo.lock"),
    [
      "[[package]]",
      'name = "tauri"',
      'version = "2.11.5"',
      "",
      "[[package]]",
      'name = "personal-assistant-shell"',
      `version = "${version}"`,
      "",
    ].join("\n"),
  );
}

function writeReleaseFixture(root, version, changelog) {
  for (const directory of [
    "app/server",
    "app/shared",
    "app/web",
    "app/shell",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of MANIFESTS) {
    writeFileSync(join(root, file), JSON.stringify({ version }));
  }
  writeFileSync(
    join(root, "flake.nix"),
    `package = { version = "1";\n  version = "${version}";\n};\n`,
  );
  writeShellFixture(root, version);
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
}

/** A git repository whose `main` carries the release fixture, one commit deep. */
function gitFixture(version, changelog) {
  const root = mkdtempSync(join(tmpdir(), "pa-release-check-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Release Fixture");
  git("config", "commit.gpgsign", "false");
  writeReleaseFixture(root, version, changelog);
  git("add", "-A");
  git("commit", "-qm", `Release ${version}`);
  return { root, git };
}

function runReleaseCheck(root, version, extra = []) {
  return spawnSync(
    process.execPath,
    [join(scriptsDir, "release-check.mjs"), version, "--root", root, ...extra],
    { encoding: "utf8" },
  );
}

test("release check passes a coherent tree and prints target and notes", () => {
  const version = "1.0.0-rc.1+build.7";
  const changelog = `# Changelog\n\n## [${version}] - 2026-08-10\n\n- Release ${version}\n`;
  const { root, git } = gitFixture(version, changelog);

  const result = runReleaseCheck(root, version);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(git("rev-parse", "HEAD")));
  assert.match(result.stdout, /Tag: +v1\.0\.0-rc\.1\+build\.7/);
  assert.ok(
    result.stdout.endsWith(extractChangelogSection(changelog, version)),
    "prints the exact changelog section last",
  );
});

test("release check refuses a version the tree does not declare everywhere", () => {
  const changelog = "# Changelog\n\n## [0.3.0]\n\n- Release 0.3.0\n";
  const { root } = gitFixture("0.3.0", changelog);
  writeFileSync(
    join(root, "app/web/package.json"),
    JSON.stringify({ version: "0.2.0" }),
  );

  const result = runReleaseCheck(root, "0.3.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Declared versions do not match 0\.3\.0/);
  assert.match(result.stderr, /app\/web\/package\.json: 0\.2\.0/);
});

test("release check refuses a missing, empty, or duplicated changelog section", () => {
  for (const changelog of [
    "# Changelog\n",
    "# Changelog\n\n## [0.3.0]\n\n## [0.1.0]\n\n- Old\n",
    "# Changelog\n\n## [0.3.0]\n\n- One\n\n## [0.3.0]\n\n- Two\n",
  ]) {
    const { root } = gitFixture("0.3.0", changelog);
    assert.throws(() => extractChangelogSection(changelog, "0.3.0"));
    assert.equal(runReleaseCheck(root, "0.3.0").status, 1);
  }
});

test("release check refuses a target off the branch's first-parent history", () => {
  const changelog = "# Changelog\n\n## [0.3.0]\n\n- Release 0.3.0\n";
  const { root, git } = gitFixture("0.3.0", changelog);
  git("checkout", "-q", "-b", "side");
  writeFileSync(join(root, "unmerged.txt"), "work in progress\n");
  git("add", "-A");
  git("commit", "-qm", "Unmerged work");
  const unmerged = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");

  const result = runReleaseCheck(root, "0.3.0", ["--ref", unmerged]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /first-parent history/);
  // The same tree still releases from main, so the rejection is about the
  // TARGET, not about the fixture being unreleasable.
  assert.equal(runReleaseCheck(root, "0.3.0").status, 0);
});

test("version declarations are read from every place that carries one", () => {
  const { root } = gitFixture("0.3.0", "# Changelog\n\n## [0.3.0]\n\n- x\n");
  assert.deepEqual(
    readDeclaredVersions(root).map((entry) => entry.file),
    [...MANIFESTS, ...EMBEDDED],
  );
  assert.equal(assertDeclaredVersion(root, "0.3.0"), "0.3.0");
  assert.throws(
    () => assertDeclaredVersion(root, "0.4.0"),
    /version:set 0\.4\.0/,
  );
});

test("duplicate SemVer declarations in flake.nix are rejected", () => {
  const { root } = gitFixture("0.3.0", "# Changelog\n\n## [0.3.0]\n\n- x\n");
  const flakePath = join(root, "flake.nix");
  writeFileSync(
    flakePath,
    `${readFileSync(flakePath, "utf8")}  version = "1.2.3";\n`,
  );

  assert.throws(
    () => readDeclaredVersions(root),
    /Expected exactly one version declaration in flake\.nix, found 2/,
  );
});

test("the native shell's version is part of a coherent release", () => {
  const changelog = "# Changelog\n\n## [0.3.0]\n\n- Release 0.3.0\n";
  const { root } = gitFixture("0.3.0", changelog);
  // The shell shipping the previous version is exactly the drift the About
  // panel showed before the setter owned these files.
  writeShellFixture(root, "0.2.0");

  const result = runReleaseCheck(root, "0.3.0");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /app\/shell\/tauri\.conf\.json: 0\.2\.0/);
});

test("first-parent membership decides a release target", () => {
  const merges = ["a".repeat(40), "b".repeat(40)];
  assert.equal(assertOnFirstParentHistory(merges[1], merges), merges[1]);
  assert.throws(
    () => assertOnFirstParentHistory("c".repeat(40), merges),
    /not on the protected branch/,
  );
});

test("version setter updates every declaration and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "pa-version-"));
  for (const directory of [
    "app/server",
    "app/shared",
    "app/web",
    "app/shell",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const file of MANIFESTS) {
    writeFileSync(join(root, file), '{"name":"fixture","version":"0.1.0"}\n');
  }
  writeFileSync(
    join(root, "flake.nix"),
    'package = {\n  version = "0.1.0";\n};\n',
  );
  writeShellFixture(root, "0.1.0");

  assert.deepEqual(setRepositoryVersion(root, "0.2.0"), [
    ...MANIFESTS,
    ...EMBEDDED,
  ]);

  for (const file of MANIFESTS) {
    assert.equal(JSON.parse(readFileSync(join(root, file))).version, "0.2.0");
  }
  assert.match(
    readFileSync(join(root, "flake.nix"), "utf8"),
    /version = "0\.2\.0";/,
  );
  // The surrounding declarations survive: only the captured version moves, and
  // the dependency versions beside it are left alone.
  const cargo = readFileSync(join(root, "app/shell/Cargo.toml"), "utf8");
  assert.match(
    cargo,
    /\[package\]\nname = "personal-assistant-shell"\nversion = "0\.2\.0"/,
  );
  assert.match(cargo, /tauri = \{ version = "2", features = \[\] \}/);
  const lock = readFileSync(join(root, "app/shell/Cargo.lock"), "utf8");
  assert.match(lock, /name = "personal-assistant-shell"\nversion = "0\.2\.0"/);
  assert.match(lock, /name = "tauri"\nversion = "2\.11\.5"/);
  assert.equal(
    readDeclaredVersions(root).every((e) => e.version === "0.2.0"),
    true,
  );
});

test("first-parent changes group Task merges and link every PR", () => {
  const changes = collectChanges(
    [
      {
        hash: "a".repeat(40),
        subject: "Task-362: Release management (#63)",
      },
      { hash: "b".repeat(40), subject: "Maintenance (#64)" },
      { hash: "c".repeat(40), subject: "Direct fix" },
    ],
    "https://github.com/owner/repo",
  );

  assert.deepEqual(changes.tasks, [
    {
      task: "Task-362",
      title: "Release management",
      pulls: ["[PR #63](https://github.com/owner/repo/pull/63)"],
    },
  ]);
  assert.match(changes.other[0], /pull\/64/);
  assert.match(changes.other[1], /commit\/cccc/);
});

test("squash subjects keep parentheses in titles and reverts", () => {
  const changes = collectChanges(
    [
      { hash: "a".repeat(40), subject: "Fix (re)connect handling (#70)" },
      {
        hash: "b".repeat(40),
        subject: 'Revert "Fix (re)connect handling (#70)"',
      },
      {
        hash: "c".repeat(40),
        subject: 'Revert "Fix (re)connect handling (#70)" (#71)',
      },
      { hash: "d".repeat(40), subject: "Tidy (no PR)" },
    ],
    "https://github.com/owner/repo",
  );

  assert.deepEqual(changes.other, [
    "- Fix (re)connect handling ([PR #70](https://github.com/owner/repo/pull/70))",
    `- Revert "Fix (re)connect handling (#70)" ([bbbbbbbb](https://github.com/owner/repo/commit/${"b".repeat(40)}))`,
    '- Revert "Fix (re)connect handling (#70)" ([PR #71](https://github.com/owner/repo/pull/71))',
    `- Tidy (no PR) ([dddddddd](https://github.com/owner/repo/commit/${"d".repeat(40)}))`,
  ]);
});

test("SSH remotes become browser URLs without the SSH port", () => {
  assert.equal(
    repositoryWebUrl("ssh://git@git.example.test:2222/owner/repository.git"),
    "https://git.example.test/owner/repository",
  );
});
