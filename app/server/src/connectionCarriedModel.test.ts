/**
 * A new session started from a view carries the viewed session's model and
 * thinking level (`connection.ts` `viewedModelSelection`/`resolveViewedModel`).
 * What is looked up, and where, for every viewing state.
 *
 *   pnpm --filter @assistant/server test src/connectionCarriedModel.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";

const tmp = mkdtempSync(join(tmpdir(), "connection-carried-model-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
// Enabled, so a stored Claude session can be viewed at all.
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

vi.mock("./piSdk/models.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./piSdk/models.ts")>()),
  findModel: vi.fn(),
  findModelForProfile: vi.fn(),
}));

const { Connection } = await import("./connection.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { ClaudeSdkSession } = await import("./claudeSdk/ClaudeSdkSession.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { viewSessionById } = await import("./viewSession.ts");
const { findModel, findModelForProfile } = await import("./piSdk/models.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(findModel).mockReset();
  vi.mocked(findModelForProfile).mockReset();
});

const codexProfile = createCredentialProfile({
  name: "Pi account",
  provider: "openai-codex",
});

const idleSeam: ClaudeSdkSeam = {
  query: () => ({
    async *[Symbol.asyncIterator]() {
      // No turn runs in these tests.
    },
  }),
};

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

type Resident = InstanceType<typeof ClaudeSdkSession>;

/** Start a new session from `viewed` (or from nothing) and report what it carried. */
async function carriedFrom(
  viewed: string | undefined,
  residents: Map<string, Resident>,
): Promise<{ model: unknown; thinkingLevel: unknown }> {
  vi.spyOn(hub, "viewById").mockImplementation(
    (id: string) => residents.get(id) ?? viewSessionById(id),
  );
  const acquireNew = vi.spyOn(piStore, "acquireNew").mockImplementation(
    async () =>
      new ClaudeSdkSession(`created-${Math.random()}`, {
        seam: async () => idleSeam,
      }) as never,
  );
  vi.spyOn(hub, "broadcastSessions").mockResolvedValue(undefined);
  const connection = new Connection(fakeSocket([]));
  if (viewed) {
    void connection.handle({
      type: "loadSession",
      id: viewed,
    } as ClientMessage);
    await settle();
    // Viewing looks up the stored model for display; only what creation
    // looks up counts here.
    vi.mocked(findModel).mockClear();
    vi.mocked(findModelForProfile).mockClear();
  }
  await connection.handle({
    type: "newSession",
    agentType: "assistant",
  } as ClientMessage);
  await settle();
  const call = acquireNew.mock.calls.at(-1);
  expect(call, "a session was created").toBeDefined();
  return { model: call?.[1], thinkingLevel: call?.[2] };
}

test("a resident pi session's model resolves on the account it runs on", async () => {
  const handle = { provider: "openai-codex", id: "gpt-5" };
  vi.mocked(findModelForProfile).mockResolvedValue(handle as never);
  const resident = new ClaudeSdkSession("resident-pi", {
    seam: async () => idleSeam,
  });
  Object.defineProperty(resident, "credentialProfileId", {
    value: codexProfile.id,
  });
  resident.modelSelection = () => ({
    model: { provider: "openai-codex", id: "gpt-5" },
    thinkingLevel: "low",
  });

  const carried = await carriedFrom(
    "resident-pi",
    new Map([["resident-pi", resident]]),
  );

  expect(vi.mocked(findModelForProfile).mock.calls).toEqual([
    [codexProfile.id, "openai-codex", "gpt-5"],
  ]);
  expect(vi.mocked(findModel)).not.toHaveBeenCalled();
  expect(carried).toEqual({ model: handle, thinkingLevel: "low" });
});

test("a stored pi row's model resolves through the global registry", async () => {
  const handle = { provider: "openai-codex", id: "gpt-5" };
  vi.mocked(findModel).mockReturnValue(handle as never);
  sessionStore.upsert({
    id: "stored-pi",
    harness: "pi",
    agentType: "assistant",
    provider: "openai-codex",
    model: "gpt-5",
    thinkingLevel: "medium",
    credentialProfileId: codexProfile.id,
  });

  const carried = await carriedFrom("stored-pi", new Map());

  expect(vi.mocked(findModel).mock.calls).toEqual([["openai-codex", "gpt-5"]]);
  expect(vi.mocked(findModelForProfile)).not.toHaveBeenCalled();
  expect(carried).toEqual({ model: handle, thinkingLevel: "medium" });
});

test("a resident Claude session carries its thinking level but no model", async () => {
  const resident = new ClaudeSdkSession("resident-claude", {
    modelId: "opus",
    thinkingLevel: "high",
    seam: async () => idleSeam,
  });

  const carried = await carriedFrom(
    "resident-claude",
    new Map([["resident-claude", resident]]),
  );

  expect(vi.mocked(findModelForProfile)).not.toHaveBeenCalled();
  expect(vi.mocked(findModel)).not.toHaveBeenCalled();
  expect(carried).toEqual({ model: undefined, thinkingLevel: "high" });
});

test("a stored Claude row carries its thinking level but no model", async () => {
  sessionStore.upsert({
    id: "stored-claude",
    harness: "claude-sdk",
    agentType: "assistant",
    provider: "claude",
    model: "opus",
    thinkingLevel: "low",
  });

  const carried = await carriedFrom("stored-claude", new Map());

  // The stored provider is the account kind, which no pi registry knows.
  expect(vi.mocked(findModelForProfile)).not.toHaveBeenCalled();
  expect(carried).toEqual({ model: undefined, thinkingLevel: "low" });
});

test("nothing viewed carries nothing", async () => {
  const carried = await carriedFrom(undefined, new Map());

  expect(vi.mocked(findModelForProfile)).not.toHaveBeenCalled();
  expect(vi.mocked(findModel)).not.toHaveBeenCalled();
  expect(carried).toEqual({ model: undefined, thinkingLevel: undefined });
});
