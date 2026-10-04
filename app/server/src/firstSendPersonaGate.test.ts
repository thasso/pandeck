/**
 * The persona creation guard of a first send (`Connection.handleFirstSend`):
 * each engine names its gate (`harnesses/firstSend.ts` `personaGate`), and the
 * guard refuses before the view is claimed or anything is looked up.
 *
 * - pi passes the environment gate (`isAgentAvailable`).
 * - Claude refuses only the server-owned personas, so a Claude workshop stays
 *   creatable where pi's gate would refuse it.
 * - Claude's ownership refusal comes before the persona guard.
 *
 *   pnpm --filter @assistant/server test src/firstSendPersonaGate.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "first-send-persona-gate-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({ claudeSdk: { enabled: true } }),
);

// The environment gate, steered per test; everything else is the real one.
const available = vi.fn<(kind: string) => boolean>(() => true);
vi.mock("./agents.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents.ts")>()),
  isAgentAvailable: (kind: string) => available(kind),
}));

const { Connection } = await import("./connection.ts");
const { claudeSdkStore } = await import("./claudeSdk/claudeSdkStore.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const models = await import("./piSdk/models.ts");
const { createCredentialProfile } = await import("./credentialProfiles.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
  available.mockReset();
  available.mockReturnValue(true);
});

const claudeProfile = createCredentialProfile({
  name: "Claude account",
  provider: "claude",
});
const piProfile = createCredentialProfile({
  name: "Pi account",
  provider: "openai-codex",
});

/** A first send on a fresh connection, with every later step observed. */
function firstSend(msg: Record<string, unknown>) {
  const sent: Array<{ type: string; message?: string }> = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => {
      handleFirstSend: (msg: Record<string, unknown>) => Promise<void>;
      claimViewRequest: (target?: string) => number;
    }
  )({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
  });
  const claim = vi.spyOn(conn, "claimViewRequest");
  const claudeCreate = vi
    .spyOn(claudeSdkStore, "acquire")
    .mockImplementation(() => {
      throw new Error("reached the session");
    });
  const piCreate = vi.spyOn(piStore, "acquireNew").mockImplementation(() => {
    throw new Error("reached the session");
  });
  const modelLookup = vi.spyOn(models, "findModelForProfile");
  return {
    sent,
    claim,
    claudeCreate,
    piCreate,
    modelLookup,
    run: () =>
      conn.handleFirstSend({ text: "hello", clientRequestId: "creq", ...msg }),
  };
}

test("a Claude send for a server-owned persona is refused before anything", async () => {
  for (const agentType of ["personal-assistant", "workflow-coordinator"]) {
    const send = firstSend({
      harness: "claude-sdk",
      id: `owned-${agentType}`,
      agentType,
      credentialProfileId: claudeProfile.id,
    });
    await send.run();
    assert.deepEqual(send.sent.at(-1), {
      type: "error",
      message: `The "${agentType}" agent cannot be created.`,
    });
    assert.equal(send.claim.mock.calls.length, 0, "no view claimed");
    assert.equal(send.claudeCreate.mock.calls.length, 0, "no session");
  }
});

test("a Claude workshop stays creatable where pi's environment gate refuses it", async () => {
  available.mockImplementation((kind) => kind !== "workshop");
  const send = firstSend({
    harness: "claude-sdk",
    id: "claude-workshop",
    agentType: "workshop",
    credentialProfileId: claudeProfile.id,
  });
  await assert.rejects(send.run(), /reached the session/);
  assert.ok(!send.sent.some((m) => m.type === "error"));
});

test("a pi send passes the environment gate before its account or model", async () => {
  available.mockImplementation((kind) => kind !== "workshop");
  const send = firstSend({
    harness: "pi",
    id: "pi-workshop",
    agentType: "workshop",
    credentialProfileId: piProfile.id,
    modelProvider: "openai-codex",
    modelId: "gpt-5",
  });
  await send.run();
  assert.deepEqual(send.sent.at(-1), {
    type: "error",
    message: `The "workshop" agent is not available.`,
  });
  assert.equal(send.claim.mock.calls.length, 0, "no view claimed");
  assert.equal(send.modelLookup.mock.calls.length, 0, "no model lookup");
  assert.equal(send.piCreate.mock.calls.length, 0, "no session");
});

test("Claude's ownership refusal comes before the persona guard", async () => {
  vi.spyOn(piStore, "getLiveById").mockImplementation((id) =>
    id === "pi-held" ? ({ id } as never) : undefined,
  );
  const send = firstSend({
    harness: "claude-sdk",
    id: "pi-held",
    agentType: "personal-assistant",
    credentialProfileId: claudeProfile.id,
  });
  await send.run();
  assert.equal(
    send.sent.at(-1)?.message,
    "Session pi-held belongs to the pi harness.",
  );
});
