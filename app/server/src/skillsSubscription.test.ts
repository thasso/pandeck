import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "skills-subscribe-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { AGENTS_LIBRARY_DIR, SKILLS_LIBRARY_DIR } = await import("./config.ts");
const { setAgentRuntimeSourcesForTests } =
  await import("./agents/agentRuntime.ts");
const { setAgentSpawnSourcesForTests } = await import("./agents/agentSpawn.ts");
const { setLibraryBroadcaster } = await import("./library/libraryPublish.ts");

afterAll(() => {
  setLibraryBroadcaster({ broadcast: () => {} });
  rmSync(tmp, { recursive: true, force: true });
});

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  return { connection, sent };
}

test("the library topics are known subscriptions", () => {
  assert.equal(
    validateClientMessage({ type: "subscribe", topics: ["skills", "agents"] })
      .ok,
    true,
  );
});

test("subscribing scans the library and answers through the topic seam", async () => {
  await mkdir(join(SKILLS_LIBRARY_DIR, "review-pass"), { recursive: true });
  await writeFile(
    join(SKILLS_LIBRARY_DIR, "review-pass", "SKILL.md"),
    "---\nname: review-pass\ndescription: Review a change.\n---\n\nBody.\n",
    "utf8",
  );
  const broadcasts: ServerMessage[] = [];
  setLibraryBroadcaster({
    broadcast: (message) => broadcasts.push(message),
  });
  const { connection, sent } = makeConnection();
  const subscribe = (
    connection as unknown as {
      onSubscribe: (topics: BroadcastTopic[]) => void;
    }
  ).onSubscribe.bind(connection);

  subscribe(["skills"]);
  // Session-start resolution now scans this same working tree too. Under the
  // full parallel suite the filesystem pool can be busy, so wait for the
  // promised publish rather than assuming one scan always finishes in 50 ms.
  await vi.waitFor(() => assert.equal(broadcasts.length, 1), {
    timeout: 2_000,
    interval: 10,
  });

  // The answer travels on the topic, not as a private per-connection shape:
  // every window showing the library sees the same authoritative scan.
  assert.equal(
    sent.filter((message) => message.type === "libraryList").length,
    0,
  );
  assert.equal(broadcasts.length, 1);
  const message = broadcasts[0];
  assert.ok(message?.type === "libraryList");
  assert.deepEqual(message.list?.entries, [
    {
      name: "review-pass",
      description: "Review a change.",
      path: "review-pass/SKILL.md",
    },
  ]);

  // Re-subscribing is a no-op while the topic is already held; the fresh scan
  // belongs to the transition into the surface.
  subscribe(["skills"]);
  assert.equal(broadcasts.length, 1);
});

test("subscribing to agents answers with each definition's runtime or problem", async () => {
  for (const [name, model] of [
    ["reviewer", "opus"],
    ["stale", "gemini"],
  ]) {
    await mkdir(join(AGENTS_LIBRARY_DIR, name!), { recursive: true });
    await writeFile(
      join(AGENTS_LIBRARY_DIR, name!, "AGENT.md"),
      `---\nname: ${name}\ndescription: An agent.\npersona: developer\nmodel: ${model}\n---\n\nReview.\n`,
      "utf8",
    );
  }
  setAgentRuntimeSourcesForTests({
    models: async () => [
      {
        provider: "claude-sdk",
        id: "opus",
        name: "Opus",
        reasoning: true,
        supportedThinkingLevels: ["low", "medium", "high"],
        contextWindow: 200_000,
      },
    ],
    skillNames: async () => [],
    toolNames: async () => [],
  });
  setAgentSpawnSourcesForTests({ offers: async () => true });
  const broadcasts: Array<{ message: ServerMessage; topic: string }> = [];
  setLibraryBroadcaster({
    broadcast: (message, topic) => broadcasts.push({ message, topic }),
  });
  const { connection } = makeConnection();
  (
    connection as unknown as {
      onSubscribe: (topics: BroadcastTopic[]) => void;
    }
  ).onSubscribe(["agents"]);
  try {
    await vi.waitFor(() => assert.equal(broadcasts.length, 1), {
      timeout: 5_000,
      interval: 10,
    });
    const [{ message, topic }] = broadcasts as [
      { message: ServerMessage; topic: string },
    ];
    assert.equal(topic, "agents");
    assert.ok(message.type === "libraryList" && message.library === "agents");
    assert.deepEqual(
      message.list?.entries.map((entry) => entry.name),
      ["reviewer", "stale"],
    );
    assert.deepEqual(message.list?.agentRuntimes?.reviewer, {
      persona: "developer",
      provider: "claude-sdk",
      modelId: "opus",
      thinkingLevel: "medium",
      models: [
        {
          spec: "opus",
          provider: "claude-sdk",
          modelId: "opus",
          thinkingLevel: "medium",
        },
      ],
    });
    assert.match(
      message.list?.agentRuntimes?.stale?.problem ?? "",
      /No enabled account offers a model "gemini"/,
    );
  } finally {
    setAgentRuntimeSourcesForTests(null);
    setAgentSpawnSourcesForTests(null);
  }
});
