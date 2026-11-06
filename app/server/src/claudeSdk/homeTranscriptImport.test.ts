/**
 * The one-time import of Default Claude's transcripts out of the user's home
 * (`docs/credential-distribution.md`). Every case runs on a fake HOME and a
 * fake profile directory, and checks that the fake home is byte-for-byte as it
 * was afterwards (names, sizes, modes, mtimes, sha256).
 *
 * The crash fixtures (F1-F11) are built on disk as a killed process leaves
 * them, then run once and compared with an uninterrupted reference run. The
 * F004 cases pin the boundary: the set-aside and a durable `copy` come before
 * the source is listed or the space checked, and until then startup refuses.
 *   pnpm --filter @assistant/server exec vitest run src/claudeSdk/homeTranscriptImport.test.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  appendFileSync,
  cpSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  homeTranscriptImportStartupRefusal,
  importDefaultClaudeHomeTranscripts,
  type HomeTranscriptImportOptions,
  type HomeTranscriptImportResult,
  type HomeTranscriptImportStep,
  type ManifestIo,
} from "./homeTranscriptImport.ts";
import {
  claudeConfigDir,
  DEFAULT_CLAUDE_PROFILE_ID,
} from "../credentialProfiles.ts";
import { sessionStore } from "../db/sessionStore.ts";

const NOW = Date.parse("2026-11-06T10:00:00Z");
const ASIDE = "projects.before-home-import-20261106T100000Z";
const MiB = 1024 * 1024;

/** Units: (key, id). U1 has an `<id>/` tree. */
const K1 = "-work-repo";
const K2 = "-other-repo";
const U1 = "u-default";
const U2 = "u-null";
const U3 = "u-k2";
const UNITS: Array<[string, string]> = [
  [K1, U1],
  [K1, U2],
  [K2, U3],
];
/** What the selection hands the import: three units, one id with no transcript, one invalid id. */
const IDS = [U1, U2, U3, "u-missing", "../evil"];

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, "home", ".claude", "projects"), 0o700);
    } catch {
      // not made unreadable
    }
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  home: string;
  S: string;
  P: string;
  D: string;
  W: string;
  A: string;
}

/** A fake home with Claude transcripts, config and a credential, and a profile directory with unrelated files. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "home-import-"));
  roots.push(root);
  const home = join(root, "home");
  const S = join(home, ".claude", "projects");
  const P = join(root, "data", "credential-profiles", "claude-default");
  const fx = {
    home,
    S,
    P,
    D: join(P, "claude", "projects"),
    W: join(P, "home-import"),
    A: join(P, "claude", ASIDE),
  };
  const put = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  };
  put(join(S, K1, `${U1}.jsonl`), line("u1-a") + line("u1-b") + line("u1-c"));
  put(join(S, K1, U1, "subagents", "agent-a.jsonl"), line("u1-sub"));
  put(join(S, K1, U1, "tool-results", "r1.txt"), "tool result body\n");
  put(join(S, K1, `${U2}.jsonl`), line("u2-a"));
  put(join(S, K2, `${U3}.jsonl`), line("u3-a") + line("u3-b"));
  put(join(S, K1, "terminal-only.jsonl"), line("terminal"));
  put(join(S, K1, "u-named.jsonl"), line("named"));
  put(join(home, ".claude", "settings.json"), '{"sentinel":"settings"}\n');
  put(join(home, ".claude", "skills", "x", "SKILL.md"), "sentinel skill\n");
  put(
    join(home, ".claude", ".credentials.json"),
    '{"sentinel":"home-credential"}\n',
  );
  put(join(P, "pi-agent", "x"), "unrelated pi state\n");
  put(join(P, "claude", ".credentials.json"), '{"sentinel":"profile-cred"}\n');
  put(join(P, "claude", "settings.json"), '{"sentinel":"profile-settings"}\n');
  return fx;
}

function line(text: string): string {
  return `${JSON.stringify({ type: "user", text })}\n`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type Node = { kind: string; size?: number; mode: number; sha256?: string };

/** Every entry under `dir`: kind, mode, and size and hash for files. */
function digest(dir: string): Record<string, Node> {
  const out: Record<string, Node> = {};
  const walk = (path: string, rel: string) => {
    const stat = lstatSync(path);
    const node: Node = {
      kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      mode: stat.mode & 0o777,
    };
    if (stat.isFile()) {
      node.size = stat.size;
      node.sha256 = sha256(path);
    }
    out[rel] = node;
    if (!stat.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path).sort();
    } catch {
      node.kind = "unreadable-dir";
      return;
    }
    for (const name of names)
      walk(join(path, name), rel ? `${rel}/${name}` : name);
  };
  if (existsSync(dir)) walk(dir, "");
  return out;
}

/** The home snapshot: the digest plus every entry's mtime. */
function homeSnapshot(home: string): Record<string, unknown> {
  const tree = digest(home);
  return Object.fromEntries(
    Object.entries(tree).map(([rel, node]) => [
      rel,
      { ...node, mtimeMs: lstatSync(join(home, rel)).mtimeMs },
    ]),
  );
}

const unrelated = (fx: Fixture) => ({
  pi: sha256(join(fx.P, "pi-agent", "x")),
  cred: sha256(join(fx.P, "claude", ".credentials.json")),
  settings: sha256(join(fx.P, "claude", "settings.json")),
});

/** One import over `fx`, asserting the fake home is untouched. */
async function run(
  fx: Fixture,
  options: HomeTranscriptImportOptions = {},
): Promise<HomeTranscriptImportResult> {
  const before = homeSnapshot(fx.home);
  const result = await importDefaultClaudeHomeTranscripts({
    homeProjectsDir: fx.S,
    profileRoot: fx.P,
    providerSessionIds: () => IDS,
    freeBytes: async () => undefined,
    now: () => NOW,
    ...options,
  });
  assert.deepEqual(homeSnapshot(fx.home), before, "the home is untouched");
  return result;
}

interface ManifestView {
  lines: number;
  effective: Record<string, { files: unknown }>;
}

/** Every line parses; the effective manifest is the last record per unit. */
function manifest(fx: Fixture): ManifestView {
  const path = join(fx.W, "manifest.jsonl");
  if (!existsSync(path)) return { lines: 0, effective: {} };
  const raw = readFileSync(path, "utf8");
  assert.ok(raw === "" || raw.endsWith("\n"), "no torn tail");
  const lines = raw.split("\n").slice(0, -1);
  const effective: ManifestView["effective"] = {};
  for (const text of lines) {
    const record = JSON.parse(text) as {
      providerSessionId: string;
      projectKey: string;
      files: Array<{ path: string; size: number; sha256: string }>;
    };
    effective[`${record.projectKey}/${record.providerSessionId}`] = {
      files: record.files,
    };
  }
  return {
    lines: lines.length,
    effective: Object.fromEntries(Object.entries(effective).sort()),
  };
}

/** The effective manifest describes exactly what is installed. */
function assertManifestMatchesInstalled(fx: Fixture): void {
  for (const { files } of Object.values(manifest(fx).effective))
    for (const file of files as Array<{
      path: string;
      size: number;
      sha256: string;
    }>) {
      const installed = join(fx.D, file.path);
      assert.equal(lstatSync(installed).size, file.size, file.path);
      assert.equal(sha256(installed), file.sha256, file.path);
    }
}

function state(fx: Fixture): Record<string, unknown> | undefined {
  const path = join(fx.W, "state.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : undefined;
}

function writeState(fx: Fixture, value: Record<string, unknown>): void {
  mkdirSync(fx.W, { recursive: true });
  writeFileSync(join(fx.W, "state.json"), `${JSON.stringify(value)}\n`);
}

/** The manifest record the import writes for a unit, from its source files. */
function recordFor(fx: Fixture, key: string, id: string): string {
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const tree = join(fx.S, key, id);
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) walk(path, `${rel}/${name}`);
      else
        files.push({
          path: `${rel}/${name}`,
          size: lstatSync(path).size,
          sha256: sha256(path),
        });
    }
  };
  if (existsSync(tree)) walk(tree, `${key}/${id}`);
  const main = join(fx.S, key, `${id}.jsonl`);
  files.push({
    path: `${key}/${id}.jsonl`,
    size: lstatSync(main).size,
    sha256: sha256(main),
  });
  return `${JSON.stringify({ providerSessionId: id, projectKey: key, files, at: new Date(NOW).toISOString() })}\n`;
}

/** Install a unit as the import would have: tree, then main, private modes. */
function install(fx: Fixture, key: string, id: string, main = true): void {
  mkdirSync(join(fx.D, key), { recursive: true, mode: 0o700 });
  const tree = join(fx.S, key, id);
  if (existsSync(tree)) {
    cpSync(tree, join(fx.D, key, id), { recursive: true });
    privateModes(join(fx.D, key, id));
  }
  if (main) {
    cpSync(join(fx.S, key, `${id}.jsonl`), join(fx.D, key, `${id}.jsonl`));
    chmodSync(join(fx.D, key, `${id}.jsonl`), 0o600);
  }
}

function privateModes(path: string): void {
  const stat = lstatSync(path);
  chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory())
    for (const name of readdirSync(path)) privateModes(join(path, name));
}

function appendRecord(fx: Fixture, text: string): void {
  mkdirSync(fx.W, { recursive: true });
  appendFileSync(join(fx.W, "manifest.jsonl"), text);
}

/** A pre-existing destination, as an earlier Pandeck or the user left it. */
function seedOldDestination(fx: Fixture): void {
  mkdirSync(join(fx.D, "-old-key"), { recursive: true });
  writeFileSync(join(fx.D, "-old-key", "old.jsonl"), line("old destination"));
}

/** An uninterrupted run over a fresh fixture: the expected end state. */
async function reference(
  seed: (fx: Fixture) => void = () => {},
): Promise<{ D: Record<string, Node>; manifest: ManifestView["effective"] }> {
  const fx = fixture();
  seed(fx);
  const result = await run(fx);
  assert.equal(result.outcome, "done");
  return { D: digest(fx.D), manifest: manifest(fx).effective };
}

/** The common end state of every crash fixture with its source present. */
async function assertCompletedLikeReference(
  fx: Fixture,
  seed: (fx: Fixture) => void = () => {},
): Promise<void> {
  const expected = await reference(seed);
  assert.deepEqual(digest(fx.D), expected.D);
  assert.deepEqual(manifest(fx).effective, expected.manifest);
  assertManifestMatchesInstalled(fx);
  assert.equal(state(fx)?.phase, "done");
  assert.equal(existsSync(join(fx.W, "staging")), false);
  assert.deepEqual(
    readdirSync(fx.W).filter((name) => name.startsWith("state.json.tmp-")),
    [],
  );
}

// AC6, AC7 ------------------------------------------------------------------

test("AC6: copies exactly the selected units, byte-identical and private, and no config or credential", async () => {
  const fx = fixture();
  const before = unrelated(fx);
  const result = await run(fx);
  assert.deepEqual(result, {
    outcome: "done",
    sourceMissing: false,
    aside: null,
    counts: {
      selected: 5,
      copied: 3,
      alreadyInstalled: 0,
      missing: 1,
      unsupported: 0,
      invalid: 1,
    },
    bytes: result.outcome === "done" ? result.bytes : 0,
    preflight: "unavailable",
  });
  const tree = digest(fx.D);
  assert.deepEqual(
    Object.keys(tree).sort(),
    [
      "",
      K2,
      `${K2}/${U3}.jsonl`,
      K1,
      `${K1}/${U1}`,
      `${K1}/${U1}.jsonl`,
      `${K1}/${U1}/subagents`,
      `${K1}/${U1}/subagents/agent-a.jsonl`,
      `${K1}/${U1}/tool-results`,
      `${K1}/${U1}/tool-results/r1.txt`,
      `${K1}/${U2}.jsonl`,
    ].sort(),
  );
  for (const [rel, node] of Object.entries(tree)) {
    if (rel === "") continue;
    assert.equal(node.mode, node.kind === "dir" ? 0o700 : 0o600, rel);
    if (node.kind === "file")
      assert.equal(node.sha256, sha256(join(fx.S, rel)), rel);
  }
  assert.equal(existsSync(join(fx.P, "claude", "skills")), false);
  assert.equal(
    readFileSync(join(fx.P, "claude", "settings.json"), "utf8"),
    '{"sentinel":"profile-settings"}\n',
  );
  assert.deepEqual(unrelated(fx), before);
  assert.equal(manifest(fx).lines, 3);
  assertManifestMatchesInstalled(fx);
  assert.equal(state(fx)?.phase, "done");
  assert.equal(existsSync(join(fx.W, "staging")), false);
});

test("AC6: by default it reads the selection, home and destination the app uses", async () => {
  const fx = fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = fx.home;
  const rows: Array<[string, string, Record<string, unknown>]> = [
    ["imp-default", U1, { credentialProfileId: DEFAULT_CLAUDE_PROFILE_ID }],
    ["imp-null", U2, {}],
    ["imp-internal", U3, { scope: "internal" }],
    ["imp-named", "u-named", { credentialProfileId: "claude-work" }],
    ["imp-deleted", "terminal-only", {}],
  ];
  for (const [id, provider, extra] of rows)
    sessionStore.upsert({
      id,
      scope: "user",
      harness: "claude-sdk",
      agentType: "developer",
      providerSessionId: provider,
      ...extra,
    });
  sessionStore.markDeleted("imp-deleted");
  const destination = join(
    claudeConfigDir(DEFAULT_CLAUDE_PROFILE_ID),
    "projects",
  );
  const work = join(
    dirname(claudeConfigDir(DEFAULT_CLAUDE_PROFILE_ID)),
    "home-import",
  );
  try {
    const before = homeSnapshot(fx.home);
    const result = await importDefaultClaudeHomeTranscripts({
      freeBytes: async () => undefined,
    });
    assert.deepEqual(homeSnapshot(fx.home), before);
    assert.equal(result.outcome, "done");
    assert.deepEqual(
      readdirSync(join(destination, K1)).sort(),
      [U1, `${U1}.jsonl`, `${U2}.jsonl`].sort(),
    );
    assert.deepEqual(readdirSync(join(destination, K2)), [`${U3}.jsonl`]);
  } finally {
    process.env.HOME = previousHome;
    rmSync(destination, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});

// AC8, AC12: crash fixtures --------------------------------------------------

test("F1: stale staging and temp state before the first state write are removed, then it completes", async () => {
  const fx = fixture();
  mkdirSync(join(fx.W, "staging", K1, U1), { recursive: true });
  writeFileSync(join(fx.W, "staging", K1, U1, "partial"), "partial");
  writeFileSync(join(fx.W, "state.json.tmp-dead"), '{"phase":"backup"');
  const before = unrelated(fx);
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
  assert.deepEqual(unrelated(fx), before);
});

test("F2: death before the set-aside rename sets the old destination aside once, under the persisted name", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  writeState(fx, { phase: "backup", aside: ASIDE });
  assert.equal((await run(fx)).outcome, "done");
  assert.deepEqual(digest(fx.A), old, "the original tree, byte-identical");
  assert.equal(state(fx)?.aside, ASIDE);
  await assertCompletedLikeReference(fx, seedOldDestination);
  const asides = readdirSync(join(fx.P, "claude")).filter((n) =>
    n.startsWith("projects.before-home-import-"),
  );
  assert.deepEqual(asides, [ASIDE]);
  // Later runs move nothing.
  assert.deepEqual(await run(fx), { outcome: "already-done" });
  assert.deepEqual(digest(fx.A), old);
});

test("F3: death after the rename, before the phase advanced, keeps the set-aside and does not set aside again", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  renameSync(fx.D, fx.A);
  writeState(fx, { phase: "backup", aside: ASIDE });
  assert.equal((await run(fx)).outcome, "done");
  assert.deepEqual(digest(fx.A), old);
  assert.equal(state(fx)?.aside, ASIDE);
  await assertCompletedLikeReference(fx, seedOldDestination);
});

test("F4: partial staging for a unit with no record is discarded and restaged", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  mkdirSync(join(fx.W, "staging", K1, U1, "subagents"), { recursive: true });
  writeFileSync(
    join(fx.W, "staging", K1, U1, "subagents", "agent-a.jsonl"),
    "x",
  );
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
});

test("F5: a recorded unit whose tree arrived but whose main did not is reinstalled and recorded again", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1, false);
  writeFileSync(join(fx.D, K1, U1, "subagents", "agent-a.jsonl"), "torn");
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
  assert.equal(
    manifest(fx).lines,
    4,
    "U1's earlier record stays; the last wins",
  );
});

test("F6: a recorded, installed unit is never restaged; later units are copied", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  const staged: string[] = [];
  const result = await run(fx, {
    afterStep: (step, id) => {
      if (step === "staged") staged.push(id!);
    },
  });
  assert.equal(result.outcome === "done" && result.counts.alreadyInstalled, 1);
  assert.deepEqual(staged.sort(), [U2, U3].sort());
  await assertCompletedLikeReference(fx);
});

test("F6b: a copy retry beside a real set-aside is not refused, and leaves the set-aside as it was", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  renameSync(fx.D, fx.A);
  writeState(fx, { phase: "copy", aside: ASIDE });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  assert.equal((await run(fx)).outcome, "done");
  assert.deepEqual(digest(fx.A), old);
  assert.equal(state(fx)?.aside, ASIDE);
  await assertCompletedLikeReference(fx, seedOldDestination);
});

test("F7: everything installed and recorded, death before done: done with nothing copied", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  for (const [key, id] of UNITS) {
    appendRecord(fx, recordFor(fx, key, id));
    install(fx, key, id);
  }
  const result = await run(fx, {
    afterStep: (step) => assert.notEqual(step, "staged"),
  });
  assert.equal(result.outcome === "done" && result.counts.copied, 0);
  assert.equal(result.outcome === "done" && result.counts.alreadyInstalled, 3);
  await assertCompletedLikeReference(fx);
});

test("F8: an installed unit the CLI appended to after an aborted run is kept unchanged", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  appendFileSync(join(fx.D, K1, `${U1}.jsonl`), line("appended by the CLI"));
  const appended = sha256(join(fx.D, K1, `${U1}.jsonl`));
  assert.equal((await run(fx)).outcome, "done");
  assert.equal(sha256(join(fx.D, K1, `${U1}.jsonl`)), appended);
  assert.ok(existsSync(join(fx.D, K1, `${U2}.jsonl`)));
  assert.ok(existsSync(join(fx.D, K2, `${U3}.jsonl`)));
  assert.equal(state(fx)?.phase, "done");
});

test("F9: a torn record after a valid one is cut, and its unit restaged and recorded on a fresh line", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  const torn = recordFor(fx, K1, U2);
  appendRecord(fx, torn.slice(0, Math.floor(torn.length / 2)));
  mkdirSync(join(fx.W, "staging", K1), { recursive: true });
  writeFileSync(join(fx.W, "staging", K1, `${U2}.jsonl`), "partial");
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
  assert.equal(manifest(fx).lines, 3, "U1, then U2 and U3 on fresh lines");
});

test("F10: with the source gone, leftovers and the torn tail are cleaned, done records sourceMissing, and home is never read again", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  renameSync(fx.D, fx.A);
  writeState(fx, { phase: "copy", aside: ASIDE });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  const installed = digest(fx.D);
  const torn = recordFor(fx, K1, U2);
  appendRecord(fx, torn.slice(0, 40));
  mkdirSync(join(fx.W, "staging", K1), { recursive: true });
  writeFileSync(join(fx.W, "staging", K1, `${U2}.jsonl`), "partial");
  writeFileSync(join(fx.W, "state.json.tmp-dead"), "{");
  const before = unrelated(fx);
  rmSync(fx.S, { recursive: true });

  const result = await run(fx);
  assert.equal(result.outcome, "done");
  assert.equal(result.outcome === "done" && result.sourceMissing, true);
  assert.equal(result.outcome === "done" && result.aside, ASIDE);
  assert.equal(result.outcome === "done" && result.counts.copied, 1);
  assert.equal(state(fx)?.sourceMissing, true);
  assert.equal(existsSync(join(fx.W, "staging")), false);
  assert.deepEqual(
    readdirSync(fx.W).filter((name) => name.startsWith("state.json.tmp-")),
    [],
  );
  assert.equal(manifest(fx).lines, 1);
  assertManifestMatchesInstalled(fx);
  assert.deepEqual(digest(fx.D), installed);
  assert.deepEqual(digest(fx.A), old);
  assert.deepEqual(unrelated(fx), before);

  // A later run does not read home: a file where the source was is no error.
  mkdirSync(dirname(fx.S), { recursive: true });
  writeFileSync(fx.S, "not a directory");
  assert.deepEqual(await run(fx), { outcome: "already-done" });
});

test("F11: with the source gone after the set-aside, done names the set-aside and leaves it as it was", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  renameSync(fx.D, fx.A);
  writeState(fx, { phase: "backup", aside: ASIDE });
  rmSync(fx.S, { recursive: true });
  const result = await run(fx);
  assert.equal(result.outcome === "done" && result.sourceMissing, true);
  assert.equal(result.outcome === "done" && result.aside, ASIDE);
  assert.equal(state(fx)?.aside, ASIDE);
  assert.deepEqual(digest(fx.A), old);
  assert.equal(existsSync(fx.D), false);
});

test("AC12: a unit's record is complete on disk before any of its renames, and its main is renamed last", async () => {
  const fx = fixture();
  const seen: string[] = [];
  await run(fx, {
    afterStep: (step, id) => {
      if (id === undefined) return;
      const unit = UNITS.find(([, unitId]) => unitId === id)!;
      const recorded = `${unit[0]}/${id}` in manifest(fx).effective;
      const main = existsSync(join(fx.D, unit[0], `${id}.jsonl`));
      const tree = existsSync(join(fx.D, unit[0], id));
      seen.push(`${id}:${step}:${recorded}:${tree}:${main}`);
    },
  });
  assert.deepEqual(seen, [
    `${U3}:staged:false:false:false`,
    `${U3}:recorded:true:false:false`,
    `${U3}:installed-main:true:false:true`,
    // U1's tree, subagents/ and tool-results/, each listed before any record.
    `${U1}:listed:false:false:false`,
    `${U1}:listed:false:false:false`,
    `${U1}:listed:false:false:false`,
    `${U1}:staged:false:false:false`,
    `${U1}:recorded:true:false:false`,
    `${U1}:installed-tree:true:true:false`,
    `${U1}:installed-main:true:true:true`,
    `${U2}:staged:false:false:false`,
    `${U2}:recorded:true:false:false`,
    `${U2}:installed-main:true:false:true`,
  ]);
});

// AC9 ------------------------------------------------------------------------

test("AC9: after done, an unreadable source is never touched", async () => {
  const fx = fixture();
  assert.equal((await run(fx)).outcome, "done");
  const after = digest(fx.P);
  chmodSync(fx.S, 0o000);
  try {
    assert.deepEqual(await run(fx), { outcome: "already-done" });
  } finally {
    chmodSync(fx.S, 0o700);
  }
  assert.deepEqual(digest(fx.P), after);
});

// AC10 -----------------------------------------------------------------------

test("AC10(1): no home transcripts on a first run: done with zero counts and no backup", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const old = digest(fx.D);
  rmSync(fx.S, { recursive: true });
  const result = await run(fx);
  assert.deepEqual(result, {
    outcome: "done",
    sourceMissing: false,
    aside: null,
    counts: {
      selected: 0,
      copied: 0,
      alreadyInstalled: 0,
      missing: 0,
      unsupported: 0,
      invalid: 0,
    },
    bytes: 0,
    preflight: "not-needed",
  });
  assert.deepEqual(digest(fx.D), old, "nothing set aside or written");
  assert.equal(state(fx)?.phase, "done");
  assert.equal(state(fx)?.aside, null);
});

test("AC10: a source that is not a directory refuses startup without a state", async () => {
  const fx = fixture();
  rmSync(fx.S, { recursive: true });
  writeFileSync(fx.S, "file");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await run(fx);
  assert.deepEqual(result, {
    outcome: "refused",
    operation: "check the home transcript directory",
    reason: "the home transcript path is not a directory",
  });
  assert.equal(state(fx), undefined);
});

test("AC10(2): a unit that vanishes mid-copy is missing; the rest completes", async () => {
  const fx = fixture();
  // Not through `run`: the hook itself removes a home file, standing in for
  // the user or the CLI between the plan and the copy.
  const result = await importDefaultClaudeHomeTranscripts({
    homeProjectsDir: fx.S,
    profileRoot: fx.P,
    providerSessionIds: () => IDS,
    freeBytes: async () => undefined,
    now: () => NOW,
    afterStep: (step) => {
      if (step === "planned") rmSync(join(fx.S, K1, `${U2}.jsonl`));
    },
  });
  assert.equal(result.outcome, "done");
  assert.equal(result.outcome === "done" && result.counts.missing, 2);
  assert.equal(result.outcome === "done" && result.counts.copied, 2);
  assert.equal(existsSync(join(fx.D, K1, `${U2}.jsonl`)), false);
  assert.equal(existsSync(join(fx.W, "staging")), false);
  assert.deepEqual(
    Object.keys(manifest(fx).effective).sort(),
    [`${K2}/${U3}`, `${K1}/${U1}`].sort(),
  );
});

test("AC10(3): a unit holding a link or a linked main is unsupported and skipped", async () => {
  const fx = fixture();
  symlinkSync("/etc/hostname", join(fx.S, K1, U1, "subagents", "link"));
  rmSync(join(fx.S, K2, `${U3}.jsonl`));
  symlinkSync(join(fx.S, K1, `${U2}.jsonl`), join(fx.S, K2, `${U3}.jsonl`));
  const result = await run(fx);
  assert.equal(result.outcome, "done");
  assert.equal(result.outcome === "done" && result.counts.unsupported, 2);
  assert.equal(result.outcome === "done" && result.counts.copied, 1);
  assert.equal(existsSync(join(fx.D, K1, `${U1}.jsonl`)), false);
  assert.equal(existsSync(join(fx.D, K1, U1)), false);
  assert.equal(existsSync(join(fx.D, K2, `${U3}.jsonl`)), false);
  assert.ok(existsSync(join(fx.D, K1, `${U2}.jsonl`)));
});

/** A home directory that is not Pandeck's: anything copied from it is a leak. */
const FOREIGN = "FOREIGN-SENTINEL";
function foreignDir(fx: Fixture, layout: Record<string, string>): string {
  const dir = join(fx.home, ".claude", "personal-config");
  for (const [path, body] of Object.entries(layout)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${FOREIGN} ${body}\n`);
  }
  return dir;
}

/** Every installed or staged file body holding the foreign sentinel. */
function leaked(fx: Fixture): string[] {
  return Object.entries({
    ...digest(fx.D),
    ...Object.fromEntries(
      Object.entries(digest(fx.W)).map(([rel, node]) => [`W/${rel}`, node]),
    ),
  })
    .filter(([, node]) => node.kind === "file")
    .map(([rel]) =>
      rel.startsWith("W/") ? join(fx.W, rel.slice(2)) : join(fx.D, rel),
    )
    .filter((path) => readFileSync(path, "utf8").includes(FOREIGN));
}

/** One import whose hook changes the home under it, as another local actor might. */
function runChangingHome(
  fx: Fixture,
  afterStep: NonNullable<HomeTranscriptImportOptions["afterStep"]>,
): Promise<HomeTranscriptImportResult> {
  return importDefaultClaudeHomeTranscripts({
    homeProjectsDir: fx.S,
    profileRoot: fx.P,
    providerSessionIds: () => IDS,
    freeBytes: async () => undefined,
    now: () => NOW,
    afterStep,
  });
}

/** U1 skipped as unsupported, U2 and U3 copied and recorded, nothing foreign anywhere. */
function assertOnlyU1Unsupported(
  fx: Fixture,
  result: HomeTranscriptImportResult,
): void {
  assert.equal(result.outcome, "done");
  if (result.outcome !== "done") return;
  assert.equal(result.counts.unsupported, 1);
  assert.equal(result.counts.copied, 2);
  assert.deepEqual(leaked(fx), []);
  assert.equal(existsSync(join(fx.D, K1, `${U1}.jsonl`)), false);
  assert.equal(existsSync(join(fx.D, K1, U1)), false);
  assert.deepEqual(
    Object.keys(manifest(fx).effective).sort(),
    [`${K1}/${U2}`, `${K2}/${U3}`].sort(),
  );
  assertManifestMatchesInstalled(fx);
  assert.equal(existsSync(join(fx.W, "staging")), false);
}

test("F001: a unit's tree replaced by a link after the plan is unsupported, and nothing behind the link is copied", async () => {
  const fx = fixture();
  const foreign = foreignDir(fx, { "settings.json": "settings" });
  const result = await runChangingHome(fx, (step) => {
    if (step !== "planned") return;
    rmSync(join(fx.S, K1, U1), { recursive: true });
    symlinkSync(foreign, join(fx.S, K1, U1));
  });
  assertOnlyU1Unsupported(fx, result);
  assert.equal((await run(fx)).outcome, "already-done");
});

test("F001: a nested tree directory replaced by a link after its parent was listed is unsupported", async () => {
  const fx = fixture();
  const foreign = foreignDir(fx, { "agent-a.jsonl": "nested" });
  let swapped = false;
  const result = await runChangingHome(fx, (step, id) => {
    if (step !== "listed" || id !== U1 || swapped) return;
    swapped = true;
    rmSync(join(fx.S, K1, U1, "subagents"), { recursive: true });
    symlinkSync(foreign, join(fx.S, K1, U1, "subagents"));
  });
  assert.ok(swapped, "the tree was listed");
  assertOnlyU1Unsupported(fx, result);
});

test("F001: a tree replaced by a look-alike link while its files are copied is caught by the recheck", async () => {
  const fx = fixture();
  const foreign = foreignDir(fx, {
    "subagents/agent-a.jsonl": "look-alike",
    "tool-results/r1.txt": "look-alike",
  });
  let swapped = false;
  const result = await runChangingHome(fx, (step, id) => {
    if (step !== "listed" || id !== U1 || swapped) return;
    swapped = true;
    renameSync(join(fx.S, K1, U1), join(fx.home, "moved-tree"));
    symlinkSync(foreign, join(fx.S, K1, U1));
  });
  assert.ok(swapped, "the tree was listed");
  assertOnlyU1Unsupported(fx, result);
});

test("F001: a project directory replaced by a link after the plan makes its units unsupported; other projects complete", async () => {
  const fx = fixture();
  const foreign = foreignDir(fx, {
    [`${U1}.jsonl`]: "main",
    [`${U1}/subagents/agent-a.jsonl`]: "tree",
    [`${U2}.jsonl`]: "main",
  });
  const result = await runChangingHome(fx, (step) => {
    if (step !== "planned") return;
    renameSync(join(fx.S, K1), join(fx.home, "moved-project"));
    symlinkSync(foreign, join(fx.S, K1));
  });
  assert.equal(result.outcome, "done");
  assert.equal(result.outcome === "done" && result.counts.unsupported, 2);
  assert.equal(result.outcome === "done" && result.counts.copied, 1);
  assert.deepEqual(leaked(fx), []);
  assert.deepEqual(Object.keys(manifest(fx).effective), [`${K2}/${U3}`]);
  assertManifestMatchesInstalled(fx);
  assert.equal(existsSync(join(fx.D, K1)), false);
  assert.equal(existsSync(join(fx.W, "staging")), false);
});

test("F001: the projects directory itself replaced by a look-alike link after the plan makes every unit unsupported", async () => {
  const fx = fixture();
  const foreign = foreignDir(fx, {
    [`${K1}/${U1}.jsonl`]: "main",
    [`${K1}/${U1}/subagents/agent-a.jsonl`]: "tree",
    [`${K1}/${U2}.jsonl`]: "main",
    [`${K2}/${U3}.jsonl`]: "main",
  });
  const result = await runChangingHome(fx, (step) => {
    if (step !== "planned") return;
    renameSync(fx.S, join(fx.home, "moved-projects"));
    symlinkSync(foreign, fx.S);
  });
  assert.equal(result.outcome, "done");
  assert.equal(result.outcome === "done" && result.counts.unsupported, 3);
  assert.equal(result.outcome === "done" && result.counts.copied, 0);
  assert.deepEqual(leaked(fx), []);
  assert.deepEqual(manifest(fx).effective, {});
  assert.equal(existsSync(join(fx.W, "staging")), false);
});

/** Before `state-copy` the boundary is not durable, so a failure refuses startup. */
const STEPS: Array<
  [HomeTranscriptImportStep, string | undefined, string | undefined]
> = [
  [
    "cleaned",
    undefined,
    "remove the import's leftover staging and temp state files",
  ],
  ["manifest-repaired", undefined, "repair the import manifest"],
  ["state-backup", "backup", "record the import's backup state"],
  ["set-aside", "backup", "set the former projects/ aside"],
  ["state-copy", "copy", undefined],
  ["planned", "copy", undefined],
  ["listed", "copy", undefined],
  ["staged", "copy", undefined],
  ["recorded", "copy", undefined],
  ["installed-tree", "copy", undefined],
  ["installed-main", "copy", undefined],
];

test.each(STEPS)(
  "AC10(4): a failure after %s leaves phase %s, refuses startup before the boundary, and the next boot completes like the reference",
  async (failAt, phase, refusedAt) => {
    const fx = fixture();
    seedOldDestination(fx);
    const old = digest(fx.D);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(fx, {
      afterStep: (step) => {
        if (step === failAt)
          throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    });
    if (refusedAt === undefined) {
      assert.deepEqual(result, { outcome: "aborted", reason: "EIO" });
      assert.ok(
        warn.mock.calls.some(([text]) => /aborted \(EIO\)/.test(String(text))),
      );
    } else {
      assert.deepEqual(result, {
        outcome: "refused",
        operation: refusedAt,
        reason: "EIO",
      });
      assert.ok(
        error.mock.calls.some(([text]) =>
          String(text).includes(`could not ${refusedAt} (EIO)`),
        ),
      );
      assert.match(
        (await homeTranscriptImportStartupRefusal(async () => result)) ?? "",
        /startup refused/,
      );
    }
    assert.equal(state(fx)?.phase, phase);
    assert.equal((await run(fx)).outcome, "done");
    await assertCompletedLikeReference(fx, seedOldDestination);
    assert.deepEqual(digest(fx.A), old);
  },
);

test("AC10: the boot wrapper never throws, whatever a seam throws", async () => {
  const fx = fixture();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const thrown = await run(fx, {
    providerSessionIds: () => {
      throw new TypeError("no code at all");
    },
  });
  // Both seams run after the boundary, so boot continues.
  assert.deepEqual(thrown, { outcome: "aborted", reason: "error" });
  const space = await run(fx, {
    freeBytes: async () => {
      throw new Error("statfs exploded");
    },
  });
  assert.equal(space.outcome, "aborted");
  assert.equal(state(fx)?.phase, "copy");
  assert.equal(existsSync(join(fx.W, "staging")), false);
});

test("a complete manifest line it did not write stops the run, changing nothing further", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, '{"someone":"else"}\n');
  const result = await run(fx);
  assert.equal(result.outcome, "aborted");
  assert.equal(existsSync(fx.D), false);
  assert.equal(state(fx)?.phase, "copy");
});

test("without a durable copy, a complete manifest line it did not write refuses startup", async () => {
  const fx = fixture();
  appendRecord(fx, '{"someone":"else"}\n');
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await run(fx);
  assert.deepEqual(result, {
    outcome: "refused",
    operation: "repair the import manifest",
    reason: "the manifest holds a line it did not write",
  });
  assert.equal(state(fx), undefined);
});

test("a set-aside next to a non-empty destination in phase backup refuses startup", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  cpSync(fx.D, fx.A, { recursive: true });
  writeState(fx, { phase: "backup", aside: ASIDE });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await run(fx);
  assert.deepEqual(result, {
    outcome: "refused",
    operation: "set the former projects/ aside",
    reason: "both the destination and its set-aside exist; resolve by hand",
  });
  assert.equal(state(fx)?.phase, "backup");
});

// AC11 -----------------------------------------------------------------------

function unitBytes(fx: Fixture, units: Array<[string, string]>): number {
  let total = 0;
  for (const [key, id] of units)
    for (const file of JSON.parse(recordFor(fx, key, id)).files as Array<{
      size: number;
    }>)
      total += file.size;
  return total;
}

test("AC11(a): a first run below the threshold keeps the boundary and stages nothing; at it, it completes", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  // A large destination main matching a unit: it is set aside before the
  // plan, so the unit is pending and counts.
  mkdirSync(join(fx.D, K1), { recursive: true });
  writeFileSync(join(fx.D, K1, `${U1}.jsonl`), "x".repeat(2 * MiB));
  const old = digest(fx.D);
  const need = Math.ceil(unitBytes(fx, UNITS) * 1.1) + 256 * MiB;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const staged: string[] = [];
  const low = await run(fx, {
    freeBytes: async () => need - 1,
    afterStep: (step, id) => {
      if (step === "staged") staged.push(id!);
    },
  });
  assert.deepEqual(low, {
    outcome: "insufficient-space",
    need,
    free: need - 1,
  });
  assert.ok(
    warn.mock.calls.some(([text]) => String(text).includes(String(need))),
  );
  assert.deepEqual(state(fx), { phase: "copy", aside: ASIDE });
  assert.deepEqual(digest(fx.A), old, "the original destination, set aside");
  assert.equal(existsSync(fx.D), false, "nothing copied");
  assert.deepEqual(staged, []);
  assert.equal(manifest(fx).lines, 0);
  assert.equal(
    await homeTranscriptImportStartupRefusal(async () => low),
    undefined,
    "startup continues",
  );
  const enough = await run(fx, { freeBytes: async () => need });
  assert.equal(enough.outcome === "done" && enough.preflight, "statfs");
  assert.equal(enough.outcome === "done" && enough.aside, ASIDE);
});

test("AC11(b,c): a retry leaves an installed unit out of the need and never stages it; equality passes", async () => {
  const fx = fixture();
  // Make U1 the large one, then install it as an earlier attempt did.
  writeFileSync(join(fx.S, K1, `${U1}.jsonl`), "y".repeat(3 * MiB));
  writeState(fx, { phase: "copy", aside: null });
  appendRecord(fx, recordFor(fx, K1, U1));
  install(fx, K1, U1);
  const need =
    Math.ceil(
      unitBytes(fx, [
        [K1, U2],
        [K2, U3],
      ]) * 1.1,
    ) +
    256 * MiB;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  assert.deepEqual(await run(fx, { freeBytes: async () => need - 1 }), {
    outcome: "insufficient-space",
    need,
    free: need - 1,
  });
  const staged: string[] = [];
  const result = await run(fx, {
    freeBytes: async () => need,
    afterStep: (step, id) => {
      if (step === "staged") staged.push(id!);
    },
  });
  assert.equal(result.outcome, "done");
  assert.ok(!staged.includes(U1));
});

// F002: the default free-space query, through the runtime's own statfs --------

/**
 * Run with the import's own free-space helper over `node:fs/promises` statfs
 * replaced by `fake` (absent when undefined), restoring it afterwards. The
 * helper is reached exactly as production reaches it: no `freeBytes` option.
 */
async function withNativeStatfs<T>(
  fake: typeof fsp.statfs | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const original = fsp.statfs;
  (fsp as { statfs: typeof fsp.statfs | undefined }).statfs = fake;
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    fsp.statfs = original;
    syncBuiltinESMExports();
  }
}

/** `run` with the import's own free-space helper: no `freeBytes` option at all. */
async function runNative(fx: Fixture): Promise<HomeTranscriptImportResult> {
  const before = homeSnapshot(fx.home);
  const result = await importDefaultClaudeHomeTranscripts({
    homeProjectsDir: fx.S,
    profileRoot: fx.P,
    providerSessionIds: () => IDS,
    now: () => NOW,
  });
  assert.deepEqual(homeSnapshot(fx.home), before, "the home is untouched");
  return result;
}

function failingStatfs(code: string, probes: string[]): typeof fsp.statfs {
  return (async (path: unknown) => {
    probes.push(String(path));
    throw Object.assign(new Error(`fixture statfs ${code}`), { code });
  }) as typeof fsp.statfs;
}

test.each(["EIO", "EACCES"])(
  "F002: a native statfs %s aborts after the boundary and before any copy, and the next boot completes",
  async (code) => {
    const fx = fixture();
    seedOldDestination(fx);
    const old = digest(fx.D);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const probes: string[] = [];
    const result = await withNativeStatfs(failingStatfs(code, probes), () =>
      runNative(fx),
    );
    assert.deepEqual(result, { outcome: "aborted", reason: code });
    assert.deepEqual(probes, [fx.P]);
    assert.deepEqual(state(fx), { phase: "copy", aside: ASIDE });
    assert.deepEqual(digest(fx.A), old);
    assert.equal(existsSync(fx.D), false, "nothing copied");
    assert.equal(manifest(fx).lines, 0);
    const retry = await runNative(fx);
    assert.equal(retry.outcome === "done" && retry.preflight, "statfs");
    await assertCompletedLikeReference(fx, seedOldDestination);
  },
);

test("F002: statfs walks up from a missing directory to its nearest existing ancestor", async () => {
  const fx = fixture();
  const probes: string[] = [];
  const original = fsp.statfs;
  const result = await withNativeStatfs(
    (async (path: Parameters<typeof fsp.statfs>[0]) => {
      probes.push(String(path));
      if (path === fx.P)
        throw Object.assign(new Error("fixture gone"), { code: "ENOENT" });
      return original(path);
    }) as typeof fsp.statfs,
    () => runNative(fx),
  );
  assert.deepEqual(probes, [fx.P, dirname(fx.P)]);
  assert.equal(result.outcome === "done" && result.preflight, "statfs");
});

test.each([
  ["no statfs in the runtime", undefined],
  ["ENOSYS", failingStatfs("ENOSYS", [])],
  ["EOPNOTSUPP", failingStatfs("EOPNOTSUPP", [])],
  [
    "ERR_METHOD_NOT_IMPLEMENTED",
    failingStatfs("ERR_METHOD_NOT_IMPLEMENTED", []),
  ],
] as const)(
  "F002: an unsupported statfs (%s) skips the space check and completes",
  async (_label, fake) => {
    const fx = fixture();
    const result = await withNativeStatfs(fake, () => runNative(fx));
    assert.equal(result.outcome === "done" && result.preflight, "unavailable");
    await assertCompletedLikeReference(fx);
  },
);

// AC12: manifest append failures and the runbook hazard -----------------------

function failingAppend(truncateFails: boolean): ManifestIo {
  return {
    async append(path, data) {
      appendFileSync(path, data.subarray(0, Math.floor(data.length / 2)));
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    },
    async truncate(path, length) {
      if (truncateFails) throw Object.assign(new Error("io"), { code: "EIO" });
      truncateSync(path, length);
    },
  };
}

test("AC12(i): a short append then ENOSPC is truncated back and the unit is not installed; a later run completes", async () => {
  const fx = fixture();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let appends = 0;
  const io = failingAppend(false);
  const result = await run(fx, {
    manifestIo: {
      async append(path, data) {
        appends += 1;
        if (appends === 2) return io.append(path, data);
        appendFileSync(path, data);
      },
      truncate: io.truncate,
    },
  });
  assert.deepEqual(result, { outcome: "aborted", reason: "ENOSPC" });
  assert.equal(manifest(fx).lines, 1, "back to the length before the append");
  const installed = Object.keys(digest(fx.D)).filter((p) =>
    p.endsWith(".jsonl"),
  );
  assert.equal(installed.length, 1, "only the first unit was installed");
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
});

test("AC12(ii): when the truncate fails too, the torn tail is repaired by the next run before it appends", async () => {
  const fx = fixture();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await run(fx, { manifestIo: failingAppend(true) });
  assert.equal(result.outcome, "aborted");
  const raw = readFileSync(join(fx.W, "manifest.jsonl"), "utf8");
  assert.ok(raw.length > 0 && !raw.endsWith("\n"), "a torn tail is left");
  assert.equal(existsSync(fx.D), false, "nothing was installed");
  assert.equal((await run(fx)).outcome, "done");
  await assertCompletedLikeReference(fx);
  assert.equal(manifest(fx).lines, 3);
});

test("AC12 runbook hazard: deleting the state after done sets the current projects/ aside again", async () => {
  const fx = fixture();
  assert.equal((await run(fx)).outcome, "done");
  const installed = digest(fx.D);
  rmSync(join(fx.W, "state.json"));
  let tick = NOW;
  const result = await run(fx, { now: () => (tick += 1000) });
  assert.equal(result.outcome, "done");
  const aside = result.outcome === "done" ? result.aside : null;
  assert.ok(aside && aside !== ASIDE);
  assert.deepEqual(digest(join(fx.P, "claude", aside)), installed);
  assert.deepEqual(digest(fx.D), installed, "copied again from home");
});

// F004: the boundary before release ------------------------------------------

test("F004: the backup state, the set-aside and a durable copy all come before the source is planned or the space checked", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  const seen: string[] = [];
  const result = await run(fx, {
    afterStep: (step) => {
      if (["state-backup", "set-aside", "state-copy", "planned"].includes(step))
        seen.push(step);
    },
    providerSessionIds: () => {
      seen.push(`plan:${String(state(fx)?.phase)}:${existsSync(fx.A)}`);
      return IDS;
    },
    freeBytes: async () => {
      seen.push(`preflight:${String(state(fx)?.phase)}`);
      return undefined;
    },
  });
  assert.equal(result.outcome, "done");
  assert.deepEqual(seen, [
    "state-backup",
    "set-aside",
    "state-copy",
    "plan:copy:true",
    "preflight:copy",
    "planned",
  ]);
});

/** A session Pandeck runs as Default Claude after startup was released. */
const FRESH = "u-fresh";

function writeFreshSession(fx: Fixture): void {
  mkdirSync(join(fx.D, K1, FRESH, "subagents"), { recursive: true });
  writeFileSync(join(fx.D, K1, `${FRESH}.jsonl`), line("fresh session"));
  writeFileSync(
    join(fx.D, K1, FRESH, "subagents", "agent-f.jsonl"),
    line("fresh sub"),
  );
}

test.each([
  ["a non-empty", true],
  ["no", false],
] as const)(
  "F004: with %s initial destination, low space releases startup; sessions created then, with no home counterpart, survive the retry",
  async (_label, seeded) => {
    const fx = fixture();
    if (seeded) seedOldDestination(fx);
    const old = seeded ? digest(fx.D) : undefined;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = () => [...IDS, FRESH];
    const low = await run(fx, {
      providerSessionIds: ids,
      freeBytes: async () => 0,
    });
    assert.equal(low.outcome, "insufficient-space");
    assert.equal(
      await homeTranscriptImportStartupRefusal(async () => low),
      undefined,
    );
    // Released: a new Default (or NULL) session writes the live destination.
    writeFreshSession(fx);
    const fresh = digest(join(fx.D, K1));
    const result = await run(fx, { providerSessionIds: ids });
    assert.equal(result.outcome, "done");
    assert.equal(result.outcome === "done" && result.counts.missing, 2);
    for (const [path, node] of Object.entries(fresh))
      assert.deepEqual(digest(join(fx.D, K1))[path], node, path);
    for (const [key, id] of UNITS)
      assert.ok(existsSync(join(fx.D, key, `${id}.jsonl`)), id);
    if (old !== undefined) assert.deepEqual(digest(fx.A), old);
    const asides = readdirSync(join(fx.P, "claude")).filter((n) =>
      n.startsWith("projects.before-home-import-"),
    );
    assert.deepEqual(asides, seeded ? [ASIDE] : []);
    assertManifestMatchesInstalled(fx);
  },
);

test.each([
  ["a non-empty", true],
  ["no", false],
] as const)(
  "F004: with %s initial destination, a same-id append and a new session after an aborted copy survive the retry",
  async (_label, seeded) => {
    const fx = fixture();
    if (seeded) seedOldDestination(fx);
    const old = seeded ? digest(fx.D) : undefined;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const aborted = await run(fx, {
      afterStep: (step, id) => {
        if (step === "installed-main" && id === U3)
          throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    });
    assert.deepEqual(aborted, { outcome: "aborted", reason: "EIO" });
    assert.equal(
      await homeTranscriptImportStartupRefusal(async () => aborted),
      undefined,
    );
    appendFileSync(join(fx.D, K2, `${U3}.jsonl`), line("appended by the CLI"));
    const appended = sha256(join(fx.D, K2, `${U3}.jsonl`));
    writeFreshSession(fx);
    const fresh = digest(join(fx.D, K1));
    const result = await run(fx);
    assert.equal(
      result.outcome === "done" && result.counts.alreadyInstalled,
      1,
    );
    assert.equal(sha256(join(fx.D, K2, `${U3}.jsonl`)), appended);
    for (const [path, node] of Object.entries(fresh))
      assert.deepEqual(digest(join(fx.D, K1))[path], node, path);
    assert.ok(existsSync(join(fx.D, K1, `${U1}.jsonl`)));
    assert.ok(existsSync(join(fx.D, K1, `${U2}.jsonl`)));
    if (old !== undefined) assert.deepEqual(digest(fx.A), old);
    assert.equal(state(fx)?.phase, "done");
  },
);

function eio(what: string): Error {
  return Object.assign(new Error(`fixture ${what}`), { code: "EIO" });
}

interface FsFaults {
  /** Fail `rename(from, to)` with EIO when this says so. */
  rename?: (from: string, to: string) => boolean;
  /** Fail the fsync of a handle opened on `path` when this says so. */
  sync?: (path: string) => boolean;
}

/**
 * Run `body` with the import's `node:fs/promises` rename and open wrapped to
 * fail as `faults` decide, restoring both afterwards. Everything else passes
 * through.
 */
async function withFsFaults<T>(
  faults: FsFaults,
  body: () => Promise<T>,
): Promise<T> {
  const original = { rename: fsp.rename, open: fsp.open };
  fsp.rename = (async (...args: Parameters<typeof fsp.rename>) => {
    if (faults.rename?.(String(args[0]), String(args[1]))) throw eio("rename");
    return original.rename(...args);
  }) as typeof fsp.rename;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await original.open(...args);
    if (faults.sync?.(String(args[0])))
      handle.sync = async () => {
        throw eio("fsync");
      };
    return handle;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    fsp.rename = original.rename;
    fsp.open = original.open;
    syncBuiltinESMExports();
  }
}

/** The phase the state file holds right now, without the test's helpers. */
function phaseOnDisk(fx: Fixture): unknown {
  return state(fx)?.phase;
}

/** Each boundary write or fsync, failing: what it refuses as, and the phase it leaves. */
const BOUNDARY_FAULTS: Array<
  [string, (fx: Fixture) => FsFaults, string, string | undefined, boolean]
> = [
  [
    "the backup state's temp-file fsync",
    (fx) => ({
      sync: (path) =>
        path.startsWith(join(fx.W, "state.json.tmp-")) &&
        phaseOnDisk(fx) === undefined,
    }),
    "record the import's backup state",
    undefined,
    false,
  ],
  [
    "the backup state's rename",
    (fx) => ({
      rename: (_from, to) =>
        to === join(fx.W, "state.json") && phaseOnDisk(fx) === undefined,
    }),
    "record the import's backup state",
    undefined,
    false,
  ],
  [
    "the backup state's directory fsync",
    (fx) => ({
      sync: (path) => path === fx.W && phaseOnDisk(fx) === "backup",
    }),
    "record the import's backup state",
    "backup",
    false,
  ],
  [
    "the set-aside rename",
    (fx) => ({ rename: (from, to) => from === fx.D && to === fx.A }),
    "set the former projects/ aside",
    "backup",
    true,
  ],
  [
    "the set-aside's parent fsync",
    (fx) => ({ sync: (path) => path === join(fx.P, "claude") }),
    "set the former projects/ aside",
    "backup",
    true,
  ],
  [
    "the copy state's temp-file fsync",
    (fx) => ({
      sync: (path) =>
        path.startsWith(join(fx.W, "state.json.tmp-")) &&
        phaseOnDisk(fx) === "backup",
    }),
    "record the import's copy state",
    "backup",
    false,
  ],
  [
    "the copy state's rename",
    (fx) => ({
      rename: (_from, to) =>
        to === join(fx.W, "state.json") && phaseOnDisk(fx) === "backup",
    }),
    "record the import's copy state",
    "backup",
    false,
  ],
  [
    // The rename landed but is not known durable: still a refusal.
    "the copy state's directory fsync",
    (fx) => ({ sync: (path) => path === fx.W && phaseOnDisk(fx) === "copy" }),
    "record the import's copy state",
    "copy",
    false,
  ],
];

for (const seeded of [true, false])
  test.each(
    BOUNDARY_FAULTS.filter(([, , , , needsSeed]) => seeded || !needsSeed),
  )(
    `F004: ${seeded ? "a non-empty" : "an empty"} initial destination, %s failing, refuses startup; the next boot completes`,
    async (_label, faults, operation, phase) => {
      const fx = fixture();
      if (seeded) seedOldDestination(fx);
      const old = seeded ? digest(fx.D) : undefined;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const planned: string[] = [];
      const result = await withFsFaults(faults(fx), () =>
        run(fx, {
          providerSessionIds: () => {
            planned.push("plan");
            return IDS;
          },
        }),
      );
      assert.deepEqual(result, {
        outcome: "refused",
        operation,
        reason: "EIO",
      });
      assert.deepEqual(planned, [], "the source is never listed");
      assert.equal(phaseOnDisk(fx), phase);
      const refusal = await homeTranscriptImportStartupRefusal(
        async () => result,
      );
      assert.ok(refusal?.includes(`could not ${operation} (EIO)`));
      assert.ok(
        error.mock.calls.some(([text]) =>
          String(text).includes(`could not ${operation} (EIO)`),
        ),
      );
      assert.ok(
        !existsSync(join(fx.D, K1)),
        "nothing was copied into the destination",
      );
      assert.equal((await run(fx)).outcome, "done");
      await assertCompletedLikeReference(
        fx,
        seeded ? seedOldDestination : undefined,
      );
      if (old !== undefined) assert.deepEqual(digest(fx.A), old);
    },
  );

test("F004: with the source gone and no durable copy, a failed done write refuses startup", async () => {
  const fx = fixture();
  rmSync(fx.S, { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await withFsFaults(
    { rename: (_from, to) => to === join(fx.W, "state.json") },
    () => run(fx),
  );
  assert.deepEqual(result, {
    outcome: "refused",
    operation: "record the finished import",
    reason: "EIO",
  });
  assert.equal(state(fx), undefined);
  assert.equal((await run(fx)).outcome, "done");
});

test("F004: in phase backup with the source gone, a failed done write refuses startup", async () => {
  const fx = fixture();
  seedOldDestination(fx);
  renameSync(fx.D, fx.A);
  writeState(fx, { phase: "backup", aside: ASIDE });
  rmSync(fx.S, { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const result = await withFsFaults(
    { rename: (_from, to) => to === join(fx.W, "state.json") },
    () => run(fx),
  );
  assert.equal(result.outcome, "refused");
  assert.equal(state(fx)?.phase, "backup");
});

test("F004: in phase copy with the source gone, a failed done write only aborts", async () => {
  const fx = fixture();
  writeState(fx, { phase: "copy", aside: null });
  rmSync(fx.S, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const result = await withFsFaults(
    { rename: (_from, to) => to === join(fx.W, "state.json") },
    () => run(fx),
  );
  assert.deepEqual(result, { outcome: "aborted", reason: "EIO" });
  assert.equal(state(fx)?.phase, "copy");
});

test.each([
  ["not JSON", "{"],
  ["an unknown phase", '{"phase":"merge","aside":null}'],
  ["a backup with no name", '{"phase":"backup","aside":null}'],
  ["a bad set-aside name", '{"phase":"copy","aside":"../projects"}'],
])(
  "F004: an import state that is %s refuses startup at any later boot, changing nothing",
  async (_label, raw) => {
    const fx = fixture();
    seedOldDestination(fx);
    mkdirSync(fx.W, { recursive: true });
    writeFileSync(join(fx.W, "state.json"), raw);
    const before = digest(fx.P);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await run(fx);
    assert.deepEqual(result, {
      outcome: "refused",
      operation: "read the import state",
      reason: "the import state is unreadable",
    });
    assert.deepEqual(digest(fx.P), before);
  },
);

// F009: visible names after failed barriers are not proof of durability. ------

for (const phase of ["copy", "done"] as const)
  test.each(["state file", "work", "profile", "profiles", "data", "config"])(
    `F009: visible ${phase} renews %s before release, and a repeated barrier failure still refuses`,
    async (barrier) => {
      const fx = fixture();
      if (phase === "done") rmSync(fx.S, { recursive: true });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const first = await withFsFaults(
        { sync: (path) => path === fx.W && phaseOnDisk(fx) === phase },
        () => run(fx),
      );
      assert.equal(first.outcome, "refused");
      assert.equal(phaseOnDisk(fx), phase);
      const target = {
        "state file": join(fx.W, "state.json"),
        work: fx.W,
        profile: fx.P,
        profiles: dirname(fx.P),
        data: dirname(dirname(fx.P)),
        config: dirname(fx.D),
      }[barrier];
      let attempted = false;
      const retry = await withFsFaults(
        { sync: (path) => (path === target ? (attempted = true) : false) },
        () =>
          run(fx, {
            providerSessionIds: () => {
              throw eio("selection");
            },
          }),
      );
      assert.ok(
        attempted,
        "renew the barrier before treating visible state as safe",
      );
      assert.equal(retry.outcome, "refused");
      assert.ok(await homeTranscriptImportStartupRefusal(async () => retry));
      const renewed: string[] = [];
      const released = await withFsFaults(
        {
          sync: (path) => {
            renewed.push(path);
            return false;
          },
        },
        () =>
          run(fx, {
            providerSessionIds: () => {
              throw eio("selection");
            },
          }),
      );
      assert.ok(renewed.includes(target!));
      assert.equal(
        released.outcome,
        phase === "copy" ? "aborted" : "already-done",
      );
      assert.equal(
        await homeTranscriptImportStartupRefusal(async () => released),
        undefined,
      );
    },
  );

test.each(["present", "missing"])(
  "F009: an existing set-aside renews its namespace before copy/done with source %s; repeated failure refuses",
  async (source) => {
    const fx = fixture();
    seedOldDestination(fx);
    const old = digest(fx.D);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fault = {
      sync: (path: string) => path === dirname(fx.D) && existsSync(fx.A),
    };
    assert.equal((await withFsFaults(fault, () => run(fx))).outcome, "refused");
    assert.equal(phaseOnDisk(fx), "backup");
    if (source === "missing") rmSync(fx.S, { recursive: true });
    const retry = await withFsFaults(fault, () => run(fx));
    assert.equal(retry.outcome, "refused");
    assert.equal(phaseOnDisk(fx), "backup");
    const renewed: string[] = [];
    const released = await withFsFaults(
      {
        sync: (path) => {
          renewed.push(path);
          return false;
        },
      },
      () =>
        run(fx, {
          freeBytes: async () => {
            throw eio("preflight");
          },
        }),
    );
    assert.ok(renewed.includes(dirname(fx.D)));
    assert.equal(released.outcome, source === "present" ? "aborted" : "done");
    assert.equal(
      await homeTranscriptImportStartupRefusal(async () => released),
      undefined,
    );
    assert.deepEqual(digest(fx.A), old);
    assert.equal(
      readdirSync(dirname(fx.D)).filter((name) =>
        name.startsWith("projects.before-"),
      ).length,
      1,
    );
  },
);

test.each([
  "data",
  "profiles",
  "profile",
  "work",
  "config",
  "destination",
  "key",
])(
  "F009: mkdir followed by failed parent fsync for %s is renewed on retry before release/install",
  async (directory) => {
    const fx = fixture();
    rmSync(dirname(dirname(fx.P)), { recursive: true });
    const created = {
      data: dirname(dirname(fx.P)),
      profiles: dirname(fx.P),
      profile: fx.P,
      work: fx.W,
      config: dirname(fx.D),
      destination: fx.D,
      key: join(fx.D, K1),
    }[directory]!;
    const parent = dirname(created);
    const fault = {
      sync: (path: string) => path === parent && existsSync(created),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await withFsFaults(fault, () => run(fx));
    const beforeCopy = ["data", "profiles", "profile", "work"].includes(
      directory,
    );
    assert.equal(first.outcome, beforeCopy ? "refused" : "aborted");
    assert.ok(existsSync(created));
    let attempted = false;
    const retry = await withFsFaults(
      {
        sync: (path) =>
          path === parent && existsSync(created) ? (attempted = true) : false,
      },
      () => run(fx),
    );
    assert.ok(
      attempted,
      "an existing directory must not skip its failed parent barrier",
    );
    // Install descendants can fail after a renewed copy boundary; ancestors cannot.
    assert.equal(retry.outcome, directory === "key" ? "aborted" : "refused");
    assert.ok(!existsSync(join(fx.D, K1, `${U1}.jsonl`)));
    const renewed: string[] = [];
    const completed = await withFsFaults(
      {
        sync: (path) => {
          renewed.push(path);
          return false;
        },
      },
      () =>
        run(fx, {
          afterStep: (step) => {
            if (step === "installed-main") assert.ok(renewed.includes(parent));
          },
        }),
    );
    assert.equal(completed.outcome, "done");
    assert.equal(manifest(fx).lines > 0, true);
  },
);

test("F010 refuted: retry after manifest-name fsync failure renews W before install without needing done", async () => {
  const fx = fixture();
  const manifestPath = join(fx.W, "manifest.jsonl");
  const first = await withFsFaults(
    { sync: (path) => path === fx.W && existsSync(manifestPath) },
    () => run(fx),
  );
  assert.equal(first.outcome, "aborted");
  assert.ok(!existsSync(join(fx.D, K1, `${U1}.jsonl`)));
  const renewed: string[] = [];
  const retry = await withFsFaults(
    {
      sync: (path) => {
        renewed.push(path);
        return false;
      },
    },
    () =>
      run(fx, {
        afterStep: (step) => {
          if (step === "cleaned") renewed.length = 0;
          if (step === "installed-main") {
            assert.ok(
              renewed.includes(fx.W),
              "staging recreation renews W even without state renewal",
            );
            throw eio("after install, before done");
          }
        },
      }),
  );
  assert.equal(retry.outcome, "aborted");
  assert.equal(phaseOnDisk(fx), "copy");
  assert.ok(existsSync(join(fx.D, K2, `${U3}.jsonl`)));
  assert.ok(manifest(fx).lines > 0);
});

test("F004: the startup gate lets every outcome with a durable boundary through, and refuses the rest loudly", async () => {
  const counts = {
    selected: 0,
    copied: 0,
    alreadyInstalled: 0,
    missing: 0,
    unsupported: 0,
    invalid: 0,
  };
  const released: HomeTranscriptImportResult[] = [
    { outcome: "already-done" },
    {
      outcome: "done",
      sourceMissing: false,
      aside: null,
      counts,
      bytes: 0,
      preflight: "statfs",
    },
    { outcome: "insufficient-space", need: 2, free: 1 },
    { outcome: "aborted", reason: "EIO" },
  ];
  for (const result of released)
    assert.equal(
      await homeTranscriptImportStartupRefusal(async () => result),
      undefined,
      result.outcome,
    );
  const refusal = await homeTranscriptImportStartupRefusal(async () => ({
    outcome: "refused",
    operation: "record the import's copy state",
    reason: "ENOSPC",
  }));
  assert.ok(refusal);
  assert.match(refusal, /^\[home-transcript-import\] startup refused: /);
  assert.ok(
    refusal.includes("could not record the import's copy state (ENOSPC)"),
  );
  assert.ok(refusal.includes("restart"));
  assert.ok(refusal.includes("Keep every file in the data directory"));
  assert.ok(refusal.includes("docs/deployment.md"));
  const unknown = await homeTranscriptImportStartupRefusal(async () => {
    throw eio("importer");
  });
  assert.ok(unknown?.includes("ended in an unknown state (EIO)"));
});
