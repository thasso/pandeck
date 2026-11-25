/**
 * A user's model pick on a resident Claude session, end to end: the real
 * `Connection` hands it to a real runtime view over a real Claude adapter, the
 * adapter resolves the alias on the session's account (`docs/agent-harnesses.md`,
 * models port), and an account that cannot run it refuses as a targeted error
 * with nothing changed and no provider call.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import type {
  ClientMessage,
  ServerMessage,
  SessionState,
} from "@assistant/shared";
import type { ClaudeSdkSeam } from "./claudeSdk/sdkSeam.ts";
import { enableClaudeSdkForTests } from "./test/claudeSdkEnabled.ts";
import { PRIVATE } from "./test/claudeListings.ts";

process.env.ASSISTANT_CWD = mkdtempSync(join(tmpdir(), "conn-claude-model-"));

const { Connection } = await import("./connection.ts");
const { attachRuntimeView } = await import("./session/attach.ts");
const { SessionRuntime } = await import("./session/runtime/runtime.ts");
const { SessionLogStore } = await import("./session/log/store.ts");
const { ClaudeSdkSession } = await import("./test/claudeSdkSession.ts");
const { createCredentialProfile, deleteCredentialProfile } =
  await import("./credentialProfiles.ts");
const { resetClaudeAccountModelsForTests } =
  await import("./harnesses/claudeAccountModels.ts");

const profiles: string[] = [];

// These suites drive Claude runs; the integration is off by default.
beforeEach(enableClaudeSdkForTests);

afterEach(() => {
  resetClaudeAccountModelsForTests();
  for (const id of profiles.splice(0)) deleteCredentialProfile(id);
});

test("a mythos pick on an account that cannot run it is a targeted error; nothing changes and nothing runs", async () => {
  const profile = createCredentialProfile({
    name: "Private",
    provider: "claude",
  });
  profiles.push(profile.id);
  resetClaudeAccountModelsForTests({ read: async () => [...PRIVATE] });

  let queries = 0;
  const seam: ClaudeSdkSeam = {
    query() {
      queries += 1;
      throw new Error("no provider call may happen");
    },
  };
  const sessionId = "claude-set-model";
  const runtime = new SessionRuntime(new SessionLogStore(true));
  const hubSession = new ClaudeSdkSession(sessionId, {
    seam: () => Promise.resolve(seam),
    credentialProfileId: profile.id,
    modelId: "opus",
    thinkingLevel: "medium",
    agentType: "workshop",
  });
  const viewed: ServerMessage[] = [];
  const view = attachRuntimeView(
    runtime,
    sessionId,
    hubSession,
    { send: (message) => viewed.push(message) },
    { buildState: () => ({ sessionId }) as unknown as SessionState },
  );

  const sent: ServerMessage[] = [];
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  });
  connection.runtimeView = view;
  // A resident session, so nothing opens a harness for it.
  connection.viewing = { sessionId, live: true, removeViewer: () => {} };
  const configBefore = await runtime.get(sessionId)!.getConfig();
  try {
    await (connection.handle as (message: ClientMessage) => Promise<void>)({
      type: "setModel",
      provider: "claude-sdk",
      id: "mythos",
    });
    // The adapter's refusal settles after `handle` returns.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      sent.filter((message) => message.type === "error"),
      [
        {
          type: "error",
          target: { type: "session", id: sessionId },
          message:
            "Private can't run Claude Mythos. Refresh the model list or sign in again to retry.",
        },
      ],
    );
    const configChanges = [...sent, ...viewed].filter(
      (message) =>
        message.type === "event" &&
        message.event.type === "sessionConfigChanged",
    );
    assert.deepEqual(configChanges, []);
    assert.equal(hubSession.toRecord().modelId, "opus");
    assert.deepEqual(
      (await runtime.get(sessionId)!.getConfig()).model,
      configBefore.model,
    );
    assert.equal(queries, 0);

    // The same path carries a model the account runs.
    await (connection.handle as (message: ClientMessage) => Promise<void>)({
      type: "setModel",
      provider: "claude-sdk",
      id: "sonnet",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sent.filter((message) => message.type === "error").length, 1);
    assert.equal(hubSession.toRecord().modelId, "sonnet");
    assert.ok(
      viewed.some(
        (message) =>
          message.type === "event" &&
          message.event.type === "sessionConfigChanged",
      ),
    );
  } finally {
    (connection.dispose as () => void)();
    view.detach();
    await runtime.disposeSession(sessionId);
  }
});
