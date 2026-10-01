import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function assertSemVer(version) {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error(
      `Invalid version "${version}". Expected SemVer without a leading v (for example, 0.2.0).`,
    );
  }
  return version;
}

export function findChangelogSection(changelog, version) {
  assertSemVer(version);
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const heading = `## [${version}]`;
  const starts = lines
    .map((line, index) =>
      line === heading || line.startsWith(`${heading} - `) ? index : -1,
    )
    .filter((index) => index >= 0);

  if (starts.length === 0) return null;
  if (starts.length > 1) {
    throw new Error(`CHANGELOG.md has more than one section for ${version}.`);
  }

  const start = starts[0] + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && line.startsWith("## ["),
  );
  const body = lines
    .slice(start, next === -1 ? lines.length : next)
    .join("\n")
    .trim();
  if (!body) throw new Error(`CHANGELOG.md section ${version} is empty.`);
  return `${body}\n`;
}

export function extractChangelogSection(changelog, version) {
  const section = findChangelogSection(changelog, version);
  if (section === null) {
    throw new Error(`CHANGELOG.md has no section for ${version}.`);
  }
  return section;
}

/** Manifests whose top-level `version` field is a declaration of the release. */
const PACKAGE_FILES = [
  "package.json",
  "app/server/package.json",
  "app/shared/package.json",
  "app/web/package.json",
];

/**
 * Declarations embedded in a larger file: each pattern matches the surrounding
 * text with the version itself in group 1, and carries `d` so the writer can
 * replace exactly that group rather than the line around it.
 *
 * Every pattern is anchored tightly enough that the file's OTHER versions — a
 * dependency's, another crate's — cannot match, and `soleMatch` refuses anything
 * but a single hit rather than silently bumping the first one it finds.
 */
const EMBEDDED_FILES = [
  {
    // The native shell's version is what its About panel and its bundle carry
    // (`tauri.conf.json` wins over the crate version for `package_info()`), so an
    // unbumped shell ships a release calling itself something else. Patched by
    // pattern rather than re-serialized: Prettier owns this file's formatting,
    // and `JSON.stringify` disagrees with it about arrays.
    file: "app/shell/tauri.conf.json",
    pattern: /^ {2}"version": "([^"]+)",$/dgm,
  },
  {
    file: "flake.nix",
    pattern:
      /^\s*version = "(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)";$/dgm,
  },
  {
    file: "app/shell/Cargo.toml",
    // The crate's own version: the first one after `[package]`, and `[^[]*?`
    // keeps the search inside that section.
    pattern: /\[package\]\n[^[]*?\nversion = "([^"]+)"/dg,
  },
  {
    file: "app/shell/Cargo.lock",
    // The lock's entry for THIS crate. It is committed, so leaving it behind
    // would make the next `cargo build` rewrite it as an unrelated diff.
    pattern: /name = "personal-assistant-shell"\nversion = "([^"]+)"/dg,
  },
];

/**
 * Every place a version is declared, as they read on disk. A release is only
 * coherent when they all agree, which is what `assertDeclaredVersion` demands;
 * this returns them so a caller can SHOW the disagreement rather than restate it.
 */
export function readDeclaredVersions(root) {
  const declarations = PACKAGE_FILES.map((file) => ({
    file,
    version: JSON.parse(readFileSync(join(root, file), "utf8")).version,
  }));
  const embedded = EMBEDDED_FILES.map(({ file, pattern }) => ({
    file,
    version: soleMatch(
      readFileSync(join(root, file), "utf8"),
      pattern,
      file,
    )[1],
  }));
  return [...declarations, ...embedded];
}

/** The one match `pattern` must have in `text`; anything else is a broken tree. */
function soleMatch(text, pattern, file) {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one version declaration in ${file}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

/** Throw unless every declaration in the tree is exactly `version`. */
export function assertDeclaredVersion(root, version) {
  assertSemVer(version);
  const wrong = readDeclaredVersions(root).filter(
    (entry) => entry.version !== version,
  );
  if (wrong.length > 0) {
    throw new Error(
      `Declared versions do not match ${version}:\n${wrong
        .map((entry) => `  ${entry.file}: ${entry.version ?? "(none)"}`)
        .join("\n")}\nRun: pnpm run version:set ${version}`,
    );
  }
  return version;
}

/**
 * Require `target` to be one of `firstParent`, the first-parent commits of the
 * protected branch. This permits releasing an older merge commit by SHA while
 * rejecting a merged branch's internals and an unmerged tip — those never faced
 * branch protection or CI as such.
 */
export function assertOnFirstParentHistory(target, firstParent) {
  if (!firstParent.includes(target)) {
    throw new Error(
      `Release target ${target} is not on the protected branch's first-parent history.`,
    );
  }
  return target;
}

export function setRepositoryVersion(root, version) {
  assertSemVer(version);
  const packages = PACKAGE_FILES.map((file) => {
    const path = join(root, file);
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value.version !== "string") {
      throw new Error(`${file} has no string version field.`);
    }
    return { path, value };
  });

  // Every read and both validations happen before the first write: a tree left
  // half-bumped is worse than one never bumped, because the next run's
  // "declarations do not match" says nothing about which half is right.
  const embedded = EMBEDDED_FILES.map(({ file, pattern }) => {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    const match = soleMatch(text, pattern, file);
    return { path, text, match };
  });

  for (const entry of packages) {
    entry.value.version = version;
    writeFileSync(entry.path, `${JSON.stringify(entry.value, null, 2)}\n`);
  }
  for (const { path, text, match } of embedded) {
    // `indices[1]` is why every pattern carries `d`: the match spans context the
    // file needs to keep, and only the captured version is replaced.
    const [start, end] = match.indices[1];
    writeFileSync(path, `${text.slice(0, start)}${version}${text.slice(end)}`);
  }

  return [...PACKAGE_FILES, ...EMBEDDED_FILES.map((entry) => entry.file)];
}
