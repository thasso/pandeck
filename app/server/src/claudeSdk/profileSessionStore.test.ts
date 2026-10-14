/**
 * The credential-profile session store: the bridge that lets PA's session
 * MUTATIONS (fork, delete) reach a named profile's transcripts.
 *
 * Interactive queries reach them through `CLAUDE_CONFIG_DIR` on the subprocess.
 * `forkSession`/`deleteSession` run IN this process and resolve the local root
 * from our own environment, so without an explicit store they look under the
 * default profile and report "Session not found" for every isolated profile —
 * which, on this machine, is most sessions. `dir` cannot fix that: it selects
 * the project key inside a root, never the root.
 *
 * These tests drive the REAL SDK functions (they are pure store manipulation —
 * no model, no network), so they check the store contract itself: layout, JSONL
 * shape, load/append/delete. Run through the server Vitest suite:
 *   pnpm --filter @assistant/server test src/claudeSdk/profileSessionStore.test.ts
 */
import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "claude-profile-store-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const {
  claudeProfileSessionStore,
  copyClaudeSessionForAccount,
  removeClaudeSessionFromAllProfiles,
  lastSavedCostState,
} = await import("./profileSessionStore.ts");
const sdk = await import("@anthropic-ai/claude-agent-sdk");

const PROFILE = "cp_testprofile";
const OTHER_PROFILE = "cp_otherprofile";
const SESSION = "11111111-2222-3333-4444-555555555555";
const CWD = "/tmp/example/project";
/** How the SDK derives a project key from a cwd. */
const PROJECT_KEY = CWD.replace(/\//g, "-");

/** Seed a native transcript in ONE profile's root, as the CLI would write it. */
function seedTranscript(profileId: string, sessionId: string): string[] {
  const uuids: string[] = [];
  const root = claudeProfileSessionStore(profileId).root;
  const path = join(root, "projects", PROJECT_KEY, `${sessionId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  let parentUuid: string | null = null;
  const lines: string[] = [];
  for (let turn = 1; turn <= 2; turn++) {
    for (const role of ["user", "assistant"] as const) {
      const uuid = randomUUID();
      uuids.push(uuid);
      lines.push(
        JSON.stringify({
          type: role,
          uuid,
          parentUuid,
          sessionId,
          timestamp: new Date(1_800_000_000_000 + lines.length).toISOString(),
          cwd: CWD,
          version: "1.0.0",
          message:
            role === "user"
              ? { role: "user", content: `prompt ${turn}` }
              : {
                  role: "assistant",
                  content: [{ type: "text", text: `answer ${turn}` }],
                },
        }),
      );
      parentUuid = uuid;
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return uuids;
}

test("forking reads and writes inside the session's own profile root", async () => {
  const uuids = seedTranscript(PROFILE, SESSION);
  const store = claudeProfileSessionStore(PROFILE);

  const forked = await sdk.forkSession(SESSION, {
    ...(uuids[1] !== undefined ? { upToMessageId: uuids[1] } : {}), // through the FIRST assistant turn
    dir: CWD,
    sessionStore: store as never,
  });

  const childPath = join(
    store.root,
    "projects",
    PROJECT_KEY,
    `${forked.sessionId}.jsonl`,
  );
  const rows = readFileSync(childPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; uuid: string });
  // The SDK also writes its own `custom-title` row for the fork; the
  // conversation is what the slice is about.
  const child = rows.filter(
    (entry) => entry.type === "user" || entry.type === "assistant",
  );
  assert.deepEqual(
    child.map((entry) => entry.type),
    ["user", "assistant"],
    "the child transcript is the slice through the anchor",
  );
  assert.ok(
    child.every((entry) => !uuids.includes(entry.uuid)),
    "and its uuids are remapped, which is why copied anchors are worthless",
  );
});

test("a store rooted at the wrong profile cannot see the transcript", async () => {
  // The negative control for the bug: the same call, same `dir`, only the root
  // differs — which is exactly what happens when the mutation runs against the
  // process default instead of the session's own profile.
  await assert.rejects(
    () =>
      sdk.forkSession(SESSION, {
        dir: CWD,
        sessionStore: claudeProfileSessionStore(OTHER_PROFILE) as never,
      }),
    /not found/i,
    "an isolated profile's session is invisible from another root",
  );
});

test("deleting removes the transcript from that profile root", async () => {
  const doomed = "99999999-8888-7777-6666-555555555555";
  seedTranscript(PROFILE, doomed);
  const store = claudeProfileSessionStore(PROFILE);
  const path = join(store.root, "projects", PROJECT_KEY, `${doomed}.jsonl`);
  assert.ok(readFileSync(path, "utf8").length > 0, "seeded");

  await sdk.deleteSession(doomed, { dir: CWD, sessionStore: store as never });

  assert.throws(
    () => readFileSync(path, "utf8"),
    /ENOENT/,
    "PA owns retention, so PA's delete takes the native transcript with it",
  );
});

test("the default profile keeps using the user's own ~/.claude root", async () => {
  // The protected default profile deliberately follows the normal Claude login
  // rather than a PA-private directory; a store for it must not silently
  // redirect that.
  const store = claudeProfileSessionStore(undefined);
  assert.ok(
    store.root.endsWith("/.claude"),
    `default root should be the home config dir, got ${store.root}`,
  );
  assert.ok(
    !store.root.startsWith(join(tmp, "data")),
    "and it is NOT under the profile directory",
  );
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A transcript for `sessionId` under `projectKey` in PROFILE's root. */
function writeTranscript(
  projectKey: string,
  sessionId: string,
  lines: string[],
): string {
  const path = join(
    claudeProfileSessionStore(PROFILE).root,
    "projects",
    projectKey,
    `${sessionId}.jsonl`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n"));
  return path;
}

function costState(sessionId: string, cost: number): string {
  return JSON.stringify({
    type: "cost-state",
    sessionId,
    totalCostUSD: cost,
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 10, outputTokens: 2, costUSD: cost },
    },
  });
}

test("the last valid cost-state of the session's own transcript is the one restored", async () => {
  const session = randomUUID();
  // Another project dir holds an unrelated session; the right one is found.
  writeTranscript("-elsewhere", randomUUID(), [costState("x", 9)]);
  writeTranscript("-repo", session, [
    costState(session, 1),
    JSON.stringify({ type: "user", message: { content: "x".repeat(600_000) } }),
    costState(session, 2),
    costState("another-session", 7),
    JSON.stringify({ type: "cost-state", totalCostUSD: 8, modelUsage: {} }),
    JSON.stringify({
      type: "cost-state",
      sessionId: session,
      totalCostUSD: -1,
    }),
    JSON.stringify({ type: "last-prompt", lastPrompt: "hi" }),
    `{"type":"cost-state","sessionId":"${session}","totalCo`,
  ]);
  const entry = await lastSavedCostState(PROFILE, session);
  assert.equal(entry?.totalCostUSD, 2);
});

test("a saved cost-state before a line larger than one read chunk is still found", async () => {
  const session = randomUUID();
  writeTranscript("-repo", session, [
    costState(session, 3),
    JSON.stringify({ type: "user", message: { content: "é".repeat(400_000) } }),
  ]);
  assert.equal((await lastSavedCostState(PROFILE, session))?.totalCostUSD, 3);
});

test("no transcript, no saved totals", async () => {
  assert.equal(await lastSavedCostState(PROFILE, randomUUID()), undefined);
});

test("only a regular file under the transcript's name is read, never a link", async () => {
  const dirSession = randomUUID();
  const notAFile = join(
    claudeProfileSessionStore(PROFILE).root,
    "projects",
    "-repo",
    `${dirSession}.jsonl`,
  );
  mkdirSync(notAFile, { recursive: true });
  assert.equal(await lastSavedCostState(PROFILE, dirSession), undefined);

  const linkedSession = randomUUID();
  const target = join(tmp, "outside.jsonl");
  writeFileSync(target, costState(linkedSession, 5));
  symlinkSync(target, join(dirname(notAFile), `${linkedSession}.jsonl`));
  assert.equal(await lastSavedCostState(PROFILE, linkedSession), undefined);
});

test.each([
  [PROFILE, OTHER_PROFILE],
  [OTHER_PROFILE, PROFILE],
])(
  "account move %s → %s preserves native bytes and the full subagent tree",
  async (previous, next) => {
    const session = randomUUID();
    seedTranscript(previous, session);
    const relative = join("projects", PROJECT_KEY);
    const from = join(claudeProfileSessionStore(previous).root, relative);
    const to = join(claudeProfileSessionStore(next).root, relative);
    const main = `${session}.jsonl`;
    const body =
      readFileSync(join(from, main), "utf8") +
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "signed",
              signature: "foreign-signature",
            },
            {
              type: "tool_use",
              id: "tool1",
              name: "Bash",
              input: { command: "true" },
            },
          ],
        },
      }) +
      "\n";
    writeFileSync(join(from, main), body);
    const child = join(session, "subagents", "agent-1.jsonl");
    mkdirSync(dirname(join(from, child)), { recursive: true });
    writeFileSync(
      join(from, child),
      '{"message":{"role":"tool_result","tool_use_id":"tool1","content":"complete"}}\n',
    );
    const transfer = await copyClaudeSessionForAccount(previous, next, session);
    assert.equal(readFileSync(join(to, main), "utf8"), body);
    assert.equal(
      readFileSync(join(to, child), "utf8"),
      readFileSync(join(from, child), "utf8"),
    );
    assert.equal(
      readFileSync(join(from, main), "utf8"),
      body,
      "source stays intact until CAS commits",
    );
    await transfer.commit();
    assert.equal(existsSync(join(from, main)), false);
    assert.equal(existsSync(join(from, session)), false);
    // Returning later replaces the old snapshot, not just its main file.
    writeFileSync(
      join(to, main),
      body + '{"type":"user","message":{"content":"later"}}\n',
    );
    const returning = await copyClaudeSessionForAccount(
      next,
      previous,
      session,
    );
    assert.equal(
      readFileSync(join(from, main), "utf8"),
      readFileSync(join(to, main), "utf8"),
    );
    await returning.rollback();
    assert.equal(existsSync(join(from, main)), false);
    assert.equal(existsSync(join(from, session)), false);
    assert.ok(existsSync(join(to, main)));
  },
);

test("DELETE sweeps crash-staged account copies without deleting another session", async () => {
  const { createCredentialProfile, setCredentialProfileEnabled } =
    await import("../credentialProfiles.ts");
  const profile = createCredentialProfile({
    name: "Staged disabled account",
    provider: "claude",
  });
  setCredentialProfileEnabled(profile.id, false);
  const session = randomUUID();
  const other = randomUUID();
  const stages: string[] = [];
  for (const id of [PROFILE, profile.id]) {
    seedTranscript(id, session);
    const base = join(
      claudeProfileSessionStore(id).root,
      "projects",
      PROJECT_KEY,
    );
    for (const name of [session, other]) {
      mkdirSync(join(base, name, "subagents"), { recursive: true });
      writeFileSync(join(base, name, "subagents", "child.jsonl"), "subagent");
    }
    const stage = join(base, ".account-switch-crashed");
    stages.push(stage);
    for (const name of [session, other]) {
      mkdirSync(join(stage, name, "subagents"), { recursive: true });
      writeFileSync(join(stage, `${name}.jsonl`), "staged main");
      writeFileSync(
        join(stage, name, "subagents", "child.jsonl"),
        "staged subagent",
      );
    }
  }
  await removeClaudeSessionFromAllProfiles(session, PROFILE);
  for (const stage of stages) {
    assert.equal(existsSync(join(dirname(stage), `${session}.jsonl`)), false);
    assert.equal(existsSync(join(dirname(stage), session)), false);
    assert.equal(existsSync(join(stage, `${session}.jsonl`)), false);
    assert.equal(existsSync(join(stage, session)), false);
    assert.equal(
      readFileSync(join(stage, `${other}.jsonl`), "utf8"),
      "staged main",
    );
    assert.equal(
      readFileSync(join(stage, other, "subagents", "child.jsonl"), "utf8"),
      "staged subagent",
    );
    assert.ok(
      existsSync(join(dirname(stage), other, "subagents", "child.jsonl")),
    );
  }
});

test("account copying refuses missing history, unsafe ids and linked subagents", async () => {
  await assert.rejects(
    copyClaudeSessionForAccount(PROFILE, OTHER_PROFILE, "../outside"),
  );
  await assert.rejects(
    copyClaudeSessionForAccount(PROFILE, OTHER_PROFILE, randomUUID()),
    /complete Claude transcript/,
  );
  const session = randomUUID();
  seedTranscript(PROFILE, session);
  const base = join(
    claudeProfileSessionStore(PROFILE).root,
    "projects",
    PROJECT_KEY,
    session,
  );
  mkdirSync(base);
  const outside = join(tmp, "not-a-subagent.jsonl");
  writeFileSync(outside, "not transcript history");
  symlinkSync(outside, join(base, "linked.jsonl"));
  await assert.rejects(
    copyClaudeSessionForAccount(PROFILE, OTHER_PROFILE, session),
    /regular files/,
  );
});

test("a cost-state line split across two read chunks is read whole", async () => {
  const session = randomUUID();
  // The scan reads 256 KiB chunks from the end: a filler line just under one
  // chunk puts the chunk boundary inside the cost-state line before it.
  writeTranscript("-repo", session, [
    costState(session, 4),
    JSON.stringify({ type: "user", message: { content: "y".repeat(262_000) } }),
  ]);
  assert.equal((await lastSavedCostState(PROFILE, session))?.totalCostUSD, 4);
});
