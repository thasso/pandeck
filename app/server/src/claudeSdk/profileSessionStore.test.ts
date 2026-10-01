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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "claude-profile-store-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { claudeProfileSessionStore } = await import("./profileSessionStore.ts");
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
