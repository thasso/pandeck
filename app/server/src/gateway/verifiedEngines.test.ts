/**
 * The engine pin lock (C17.2, `docs/workers.md` "Engine-version guard"):
 * every engine package `verifiedEngines.json` names is pinned in the
 * workspace catalog at exactly the version its contract test and the
 * operator's live smoke verified. A bump that skips them fails here. The
 * Claude SDK names its bundled CLI too; pi has none.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const lock = JSON.parse(
  readFileSync(new URL("./verifiedEngines.json", import.meta.url), "utf8"),
) as Record<string, { version: string; cli?: string }>;

const workspace = readFileSync(
  new URL("../../../../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);

const CATALOG_ENTRY = /^ {2}"?([^\s":#]+)"?:\s*"?([^\s"#]+)"?\s*(?:#.*)?$/;

/** The default `catalog:` entries, by line: the server has no YAML parser. */
function catalogPins(text: string): Map<string, string> {
  const pins = new Map<string, string>();
  let inCatalog = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inCatalog = /^catalog:\s*$/.test(line);
      continue;
    }
    const entry = inCatalog ? CATALOG_ENTRY.exec(line) : null;
    if (entry) pins.set(entry[1]!, entry[2]!);
  }
  return pins;
}

/** Every way the catalog differs from the lock, as one line each. */
function lockMismatches(text: string): string[] {
  const pins = catalogPins(text);
  return Object.entries(lock).flatMap(([name, { version }]) => {
    const pinned = pins.get(name);
    if (pinned === undefined) return [`${name} is not in the catalog`];
    return pinned === version
      ? []
      : [`${name} is pinned at ${pinned}, verified at ${version}`];
  });
}

const ENGINES = [
  "@anthropic-ai/claude-agent-sdk",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];

test("every locked engine package is pinned at exactly its verified version", () => {
  assert.deepEqual(Object.keys(lock), ENGINES);
  assert.match(
    lock["@anthropic-ai/claude-agent-sdk"]!.cli ?? "",
    /^\d+\.\d+\.\d+$/,
  );
  for (const name of ENGINES.slice(1))
    assert.equal(lock[name]!.cli, undefined, `${name} has no CLI pin`);
  assert.deepEqual(lockMismatches(workspace), []);
});

test("a bumped or missing pin is a mismatch", () => {
  for (const name of ENGINES) {
    const { version } = lock[name]!;
    const line = `  "${name}": "${version}"`;
    assert.ok(
      workspace.includes(line),
      `the catalog names ${name} as expected`,
    );
    assert.deepEqual(
      lockMismatches(workspace.replace(line, `  "${name}": "99.0.0"`)),
      [`${name} is pinned at 99.0.0, verified at ${version}`],
    );
    assert.deepEqual(lockMismatches(workspace.replace(`${line}\n`, "")), [
      `${name} is not in the catalog`,
    ]);
  }
  // Only the default catalog counts, not a named one.
  const named = ENGINES.map(
    (name) => `    "${name}": "${lock[name]!.version}"\n`,
  ).join("");
  assert.deepEqual(
    lockMismatches(
      `catalog:\n  other: "1.0.0"\ncatalogs:\n  codemods:\n${named}`,
    ),
    ENGINES.map((name) => `${name} is not in the catalog`),
  );
});
