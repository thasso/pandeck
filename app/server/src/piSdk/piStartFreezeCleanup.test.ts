/**
 * A new or forked pi session whose start records cannot be frozen after a
 * successful open is undone like an enterprise refusal (`piStore`
 * `discardRefused`): the acquisition rejects, nothing is tracked, the new
 * transcript (or the fork's child) is gone, the parent is untouched and no
 * skill row is left behind.
 *
 * Real pi sessions on the in-process Worker (real codec) and a local
 * OpenAI-compatible fixture provider; nothing here sends a prompt.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piStartFreezeCleanup.test.ts
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-start-freeze-cleanup-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "openai-compatible.json"),
  JSON.stringify({
    enabled: true,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture",
    models: [
      {
        id: "chosen",
        name: "chosen",
        input: ["text"],
        contextWindow: 100_000,
        maxTokens: 4_000,
        reasoning: false,
      },
    ],
  }),
);

const freeze = vi.hoisted(() => ({ ids: [] as string[] }));
// The freeze fails after it wrote the skill row, the last record it writes:
// the cleanup must take that row back out.
vi.mock("./piEngineStart.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./piEngineStart.ts")>();
  return {
    ...real,
    freezePiEngineStart: async (
      ...args: Parameters<typeof real.freezePiEngineStart>
    ) => {
      freeze.ids.push(args[0]);
      await real.freezePiEngineStart(...args);
      throw new Error("the start records could not be stored");
    },
  };
});

await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { findModelForProfile } = await import("./models.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

afterEach(() => {
  freeze.ids.length = 0;
  vi.restoreAllMocks();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A persisted pi transcript on the fixture model: one user turn, one reply. */
function transcript(id: string): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
  const message = (
    entryId: string,
    parentId: string,
    body: Record<string, unknown>,
  ) => ({
    type: "message",
    id: entryId,
    parentId,
    timestamp: at,
    message: { ...body, timestamp: Date.now() },
  });
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id, timestamp: at, cwd: tmp },
      {
        type: "model_change",
        id: `${id}-model`,
        parentId: null,
        timestamp: at,
        provider: "openai-compatible",
        modelId: "chosen",
      },
      message(`${id}-user`, `${id}-model`, { role: "user", content: "hi" }),
      message(`${id}-reply`, `${id}-user`, {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        api: "openai-completions",
        provider: "openai-compatible",
        model: "chosen",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  return file;
}

/** The file each open named, in order. */
function openedFiles(): () => Promise<string[]> {
  const opens = vi.spyOn(
    piStore as unknown as {
      openEngine: (
        spec: unknown,
      ) => Promise<{ info: { sessionFile?: string } }>;
    },
    "openEngine",
  );
  return async () =>
    Promise.all(
      opens.mock.results.map(
        async (result) =>
          ((await result.value) as { info: { sessionFile?: string } }).info
            .sessionFile ?? "",
      ),
    );
}

function assertUndone(id: string): void {
  assert.equal(piStore.get(id), undefined, "nothing is tracked");
  assert.ok(
    !piStore.listInfo().some((info) => info.sessionId === id),
    "no live list row",
  );
  assert.equal(sessionStore.getSkills(id), undefined, "no skill row");
}

test("a new session whose start records cannot be frozen is discarded with its transcript", async () => {
  const chosen = await findModelForProfile(
    "default",
    "openai-compatible",
    "chosen",
  );
  assert.ok(chosen);
  const files = openedFiles();

  await assert.rejects(
    piStore.acquireNew("developer", chosen, "off", { cwd: tmp }),
    /the start records could not be stored/,
  );

  assert.equal(freeze.ids.length, 1);
  const id = freeze.ids[0]!;
  assertUndone(id);
  const [file] = await files();
  assert.equal(file, canonicalPiSessionPath(id));
  assert.ok(!existsSync(file!), "the new transcript is gone");
});

test("a fork whose start records cannot be frozen loses its child and leaves the parent byte-identical", async () => {
  const parentFile = transcript("freeze-parent");
  const parentBytes = readFileSync(parentFile);
  const files = openedFiles();

  await assert.rejects(
    piStore.forkSession(
      "developer",
      parentFile,
      "freeze-parent-reply",
      "at",
      "app-entry-1",
    ),
    /the start records could not be stored/,
  );

  assert.equal(freeze.ids.length, 1);
  const id = freeze.ids[0]!;
  assert.notEqual(id, "freeze-parent");
  assertUndone(id);
  const [childFile] = await files();
  assert.ok(childFile, "the fork named its child transcript");
  assert.notEqual(childFile, parentFile);
  assert.ok(!existsSync(childFile), "the fork's child transcript is gone");
  assert.deepEqual(readFileSync(parentFile), parentBytes);
  assert.ok(sessionStore.get("freeze-parent"), "the parent's record stays");
});
