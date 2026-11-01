/**
 * pi engine start parity (`docs/workers.md` "pi engine start resolution
 * (W9c-1)"): on every open path the spec the Worker decodes, the start
 * records frozen for the resulting id and the native system prompt all agree
 * with this suite's own fixtures, and a settings change afterwards moves none
 * of them for a fork, a cold reopen or a staged account reopen.
 *
 * Real pi sessions on the in-process Worker (real codec) and a local
 * OpenAI-compatible fixture provider; nothing here sends a prompt.
 *
 * Run: pnpm --filter @assistant/server test src/piSdk/piEngineStartParity.test.ts
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";
import type { PromptConditions } from "../promptConditions.ts";

const tmp = mkdtempSync(join(tmpdir(), "pi-engine-start-parity-"));
const originalHome = process.env.HOME;
process.env.HOME = tmp;
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

/** The project every session runs in, with its own context file. */
const project = join(tmp, "project");
const contextFile = {
  path: join(project, "AGENTS.md"),
  content: "# Parity project\n\nKeep the fixture stable.\n",
};
mkdirSync(project, { recursive: true });
writeFileSync(contextFile.path, contextFile.content);

await import("../hub.ts");
const { SKILLS_LIBRARY_DIR } = await import("../config.ts");
const { updateSettings } = await import("../settings.ts");
const { updateSlackSettings } = await import("../slackSettings.ts");
const { updateGoogleSettings } = await import("../googleSettings.ts");
const { updateTempoSettings } = await import("../tempoSettings.ts");
const { knowledgeBaseEnabled } = await import("../knowledgeBaseSettings.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { parsePromptConditions } = await import("../promptConditions.ts");
const { parseSessionSkills } = await import("../sessionSkills.ts");
const { freezeSessionAgent, sessionAgent } =
  await import("../agents/sessionAgent.ts");
const { agentPromptLayer } = await import("../agents/agentDefinitionPolicy.ts");
const { AGENT_TYPES } = await import("../agentTypes.ts");
const { piStore } = await import("./piStore.ts");
const { nativePiSessionForTests } = await import("./piEngine.ts");
const { findModelForProfile } = await import("./models.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");
const { answerNextInProcessWorkerCallForTests } =
  await import("../workers/inProcessWorker.ts");
const { decodeEngineOpen, ENGINE_METHODS } =
  await import("../workerProtocol/engineMethods.ts");
type PiEngineOpenSpec = import("./piEngineHost.ts").PiEngineOpenSpec;
type PiEngineHandle = import("./piEngine.ts").PiEngineHandle;
type SessionAgent = import("../agents/sessionAgent.ts").SessionAgent;

/** pi's own prompt assembly, the function its sessions render with. */
const { buildSystemPrompt } = (await import(
  join(
    dirname(
      fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
    ),
    "core",
    "system-prompt.js",
  )
)) as { buildSystemPrompt(input: Record<string, unknown>): string };

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function writeSkill(name: string): void {
  const directory = join(SKILLS_LIBRARY_DIR, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} parity skill\n---\n# ${name}\n`,
  );
}
for (const name of ["enabled-skill", "agent-skill", "later-skill"])
  writeSkill(name);

function setGates(on: boolean): void {
  updateSlackSettings({ enabled: on });
  updateGoogleSettings({ enabled: on });
  updateTempoSettings({ enabled: on });
}
setGates(false);
updateSettings({ skills: { "enabled-skill": "on" } });
/** Not flipped by this suite: a fixture input like the gates above. */
const knowledgeBase = knowledgeBaseEnabled();

const AGENT: SessionAgent = {
  name: "parity-reviewer",
  blob: "1".repeat(40),
  persona: "developer",
  provider: "openai-compatible",
  model: "chosen",
  effort: "low",
  runtimeSource: "definition",
  denyTools: ["bash", "edit"],
  skills: ["agent-skill"],
  body: "Review for parity.",
};

/** A developer session started now, with no evidence, gates off. */
const NO_EVIDENCE: PromptConditions = {
  attachments: false,
  slack: false,
  google: false,
  tempo: false,
  knowledgeBase,
  projectRegistryPointer: true,
  memoryWrite: false,
};

/** Distinct from anything computed here, so a recomputation shows. */
const PARENT_CONDITIONS: PromptConditions = {
  attachments: true,
  slack: true,
  google: false,
  tempo: true,
  knowledgeBase: !knowledgeBase,
  projectRegistryPointer: false,
  memoryWrite: false,
};
const REOPEN_CONDITIONS: PromptConditions = {
  ...PARENT_CONDITIONS,
  slack: false,
  google: true,
};

interface Expected {
  conditions: PromptConditions;
  skillNames: string[];
  agent?: SessionAgent;
}

/** Arm a capture of the next spec the Worker decodes; the real handler runs. */
function captureNextOpen(): () => PiEngineOpenSpec {
  let spec: PiEngineOpenSpec | undefined;
  answerNextInProcessWorkerCallForTests(
    ENGINE_METHODS.open,
    async (payload, signal, real) => {
      spec = decodeEngineOpen(payload).spec as PiEngineOpenSpec;
      return real(payload, signal);
    },
  );
  return () => {
    assert.ok(spec, "the Worker decoded an open");
    return spec;
  };
}

/** The developer system prompt today's assembly builds from `expected`. */
function expectedAppend(expected: Expected): string {
  return [
    AGENT_TYPES.developer.systemPrompt({ conditions: expected.conditions }),
    ...(expected.agent ? [agentPromptLayer(expected.agent)] : []),
  ].join("\n\n");
}

function assertParity(
  label: string,
  spec: PiEngineOpenSpec,
  id: string,
  engine: PiEngineHandle,
  expected: Expected,
): void {
  // The spec carries exactly the records frozen for the id...
  assert.deepEqual(
    {
      conditions: parsePromptConditions(sessionStore.getPromptConditions(id)),
      skillNames: parseSessionSkills(sessionStore.getSkills(id)),
      agent: sessionAgent(id),
    },
    {
      conditions: spec.start.conditions,
      skillNames: spec.start.skillNames,
      agent: spec.start.agent,
    },
    `${label}: the spec's start records are the frozen rows`,
  );
  // ...and those are this suite's fixtures, not the resolver's output.
  assert.deepEqual(
    spec.start,
    {
      conditions: expected.conditions,
      skillNames: expected.skillNames,
      ...(expected.agent ? { agent: expected.agent } : {}),
    },
    `${label}: the start records are the fixtures`,
  );
  // The complete native prompt: pi's base, the project context, the skills
  // and the cwd around the persona and agent layers today's assembly builds.
  const native = nativePiSessionForTests(engine);
  const base = (
    native as unknown as {
      _baseSystemPromptOptions: Record<string, unknown> & {
        skills: Array<{ name: string }>;
        contextFiles: Array<{ path: string; content: string }>;
        cwd: string;
      };
    }
  )._baseSystemPromptOptions;
  assert.deepEqual(
    base.skills.map((skill) => skill.name).sort(),
    expected.skillNames,
    `${label}: pi loaded exactly the frozen skills`,
  );
  assert.deepEqual(base.contextFiles, [contextFile], `${label}: context`);
  assert.equal(base.cwd, project, `${label}: cwd`);
  assert.equal(
    native.systemPrompt,
    buildSystemPrompt({
      ...base,
      customPrompt: undefined,
      appendSystemPrompt: expectedAppend(expected),
      contextFiles: [contextFile],
      cwd: project,
    }),
    `${label}: the native system prompt`,
  );
}

/** A persisted transcript on the fixture model, in the project. */
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
      { type: "session", version: 3, id, timestamp: at, cwd: project },
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

/** A stored session with frozen start records of its own. */
function storedSession(id: string, expected: Expected): string {
  const file = transcript(id);
  sessionStore.freezePromptConditions(id, JSON.stringify(expected.conditions));
  sessionStore.freezeSkills(id, JSON.stringify(expected.skillNames));
  if (expected.agent) freezeSessionAgent(id, expected.agent);
  return file;
}

type Staged = { engine: PiEngineHandle; dispose(): Promise<void> };
const reopenForAccount = (live: unknown, profileId: string) =>
  (
    live as { reopenForAccount(profileId: string): Promise<Staged> }
  ).reopenForAccount(profileId);

test("every open path builds from, and freezes, exactly the fixtures, and a settings change moves none of a fork's or reopen's", async () => {
  const chosen = await findModelForProfile(
    "default",
    "openai-compatible",
    "chosen",
  );
  assert.ok(chosen);
  const parent: Expected = {
    conditions: PARENT_CONDITIONS,
    skillNames: ["agent-skill"],
    agent: AGENT,
  };
  const parentFile = storedSession("parity-parent", parent);
  const parentBytes = readFileSync(parentFile);
  const reopened: Expected = {
    conditions: REOPEN_CONDITIONS,
    skillNames: ["later-skill"],
  };
  const reopenFile = storedSession("parity-reopen", reopened);
  const lives: Array<{ dispose(): void }> = [];
  const staged: Staged[] = [];

  try {
    let spec = captureNextOpen();
    const created = await piStore.acquireNew("developer", chosen, "off", {
      cwd: project,
      promptEvidence: { hasAttachments: true },
    });
    lives.push(created);
    assertParity("new", spec(), created.sessionId, created.engine, {
      conditions: { ...NO_EVIDENCE, attachments: true },
      skillNames: ["enabled-skill"],
    });

    spec = captureNextOpen();
    const spawned = await piStore.acquireNew(
      "developer",
      undefined,
      undefined,
      {
        cwd: project,
        agent: AGENT,
      },
    );
    lives.push(spawned);
    assertParity("spawn", spec(), spawned.sessionId, spawned.engine, {
      conditions: NO_EVIDENCE,
      skillNames: ["agent-skill", "enabled-skill"],
      agent: AGENT,
    });

    /** The fork, cold reopen and staged reopen, against fixed fixtures. */
    const unmoved = async (pass: string) => {
      spec = captureNextOpen();
      const forked = await piStore.forkSession(
        "developer",
        parentFile,
        "parity-parent-reply",
        "at",
        `app-entry-${pass}`,
      );
      lives.push(forked);
      assertParity(
        `fork ${pass}`,
        spec(),
        forked.sessionId,
        forked.engine,
        parent,
      );
      assert.deepEqual(
        readFileSync(parentFile),
        parentBytes,
        "the parent transcript is untouched",
      );

      piStore.evict("parity-reopen");
      spec = captureNextOpen();
      const cold = await piStore.acquireExisting(
        "developer",
        reopenFile,
        "parity-reopen",
      );
      lives.push(cold);
      assertParity(
        `cold reopen ${pass}`,
        spec(),
        "parity-reopen",
        cold.engine,
        reopened,
      );

      spec = captureNextOpen();
      const replacement = await reopenForAccount(cold, "default");
      staged.push(replacement);
      assertParity(
        `staged reopen ${pass}`,
        spec(),
        "parity-reopen",
        replacement.engine,
        reopened,
      );
    };

    await unmoved("first");
    setGates(true);
    updateSettings({
      skills: {
        "enabled-skill": "off",
        "later-skill": "on",
        "agent-skill": "on",
      },
    });
    await unmoved("after a settings change");
  } finally {
    for (const replacement of staged) await replacement.dispose();
    for (const live of lives) live.dispose();
    setGates(false);
    updateSettings({ skills: { "enabled-skill": "on" } });
  }
});
