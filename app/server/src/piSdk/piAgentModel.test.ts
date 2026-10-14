/**
 * A pi agent session runs on the model it selected, never on one pi picks
 * (`docs/agent-definitions.md` "What a spawn freezes"). pi restores a model
 * from a session's MESSAGES, so a fork before the first prompt would otherwise
 * start on pi's default, and an unrestorable model would quietly fall back.
 *
 * Real pi sessions on a local OpenAI-compatible fixture provider; nothing
 * here sends a prompt, so no request leaves the process.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piAgentModel.test.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "pi-agent-model-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
const model = (id: string) => ({
  id,
  name: id,
  input: ["text"],
  contextWindow: 100_000,
  maxTokens: 4_000,
  reasoning: false,
});
writeFileSync(
  join(tmp, "data", "settings", "openai-compatible.json"),
  JSON.stringify({
    enabled: true,
    name: "Fixture",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "fixture",
    // pi's default pick is the first model; the agent selected the second.
    models: [model("default-pick"), model("chosen")],
  }),
);

const { hub } = await import("../hub.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { freezeSessionAgent, sessionAgent } =
  await import("../agents/sessionAgent.ts");
const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { findModelForProfile } = await import("./models.ts");

(
  hub as unknown as { broadcastSessions: () => Promise<void> }
).broadcastSessions = async () => {};

const agent = {
  name: "test-reviewer",
  blob: "0".repeat(40),
  persona: "developer" as const,
  provider: "openai-compatible",
  model: "chosen",
  effort: "off" as const,
  denyTools: [],
  skills: [],
  body: "Review the tests.",
};

/** A pi transcript whose branch selected `selected`, then the given entries. */
function transcript(
  id: string,
  selected: string,
  entries: Array<Record<string, unknown>>,
): string {
  const file = canonicalPiSessionPath(id);
  mkdirSync(dirname(file), { recursive: true });
  const at = new Date().toISOString();
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
        modelId: selected,
      },
      ...entries,
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  sessionStore.upsert({ id, harness: "pi", agentType: "developer" });
  freezeSessionAgent(id, agent);
  return file;
}

test("a fork before the first prompt starts on the agent's model, not pi's default", async () => {
  const parent = "agent-fork-parent";
  const file = transcript(parent, "chosen", [
    {
      type: "message",
      id: "first-user",
      parentId: `${parent}-model`,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "start", timestamp: Date.now() },
    },
  ]);

  const child = await piStore.forkSession(
    "developer",
    file,
    "first-user",
    "before",
    "app-entry-1",
  );
  try {
    assert.equal(child.session.messages.length, 0, "an empty prefix");
    assert.equal(child.session.model?.id, "chosen");
    assert.equal(sessionAgent(child.sessionId)?.model, "chosen");
  } finally {
    child.dispose();
  }
});

test("an agent session whose model cannot be restored refuses to resume", async () => {
  const id = "agent-gone-model";
  const file = transcript(id, "retired", [
    {
      type: "message",
      id: "said",
      parentId: `${id}-model`,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "hello", timestamp: Date.now() },
    },
  ]);

  await assert.rejects(
    piStore.acquireExisting("developer", file, id),
    /Agent "test-reviewer" cannot run: .*retired.* It does not run on another model/,
  );
});

test("a bash-denying agent has no shell runner at all: no bash, no monitor", async () => {
  const chosen = await findModelForProfile(
    "default",
    "openai-compatible",
    "chosen",
  );
  assert.ok(chosen);
  const names = async (denyTools: string[]) => {
    const live = await piStore.acquireNew("developer", chosen, "off", {
      agent: { ...agent, denyTools },
    });
    try {
      return live.session.getAllTools().map((tool) => tool.name);
    } finally {
      live.dispose();
    }
  };
  const allowed = await names([]);
  assert.ok(allowed.includes("bash") && allowed.includes("monitor"));
  const denied = await names(["bash", "edit"]);
  for (const name of ["bash", "monitor", "edit"])
    assert.ok(!denied.includes(name), `${name} is not registered`);
  assert.ok(denied.includes("write") && denied.includes("read"));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
