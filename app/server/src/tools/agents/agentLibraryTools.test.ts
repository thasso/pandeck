/**
 * The `agent_*` tools (`docs/agent-definitions.md` "Authoring tools"): what a
 * definition runs on is the user's call, so a create and an edit that changes
 * `model` or `effort` become approval cards and write nothing until approved;
 * every other edit commits directly after the same runtime check, judged in
 * the locked write.
 *
 * Run with:
 *   pnpm --filter @assistant/server test src/tools/agents/agentLibraryTools.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelOption } from "@assistant/shared";
import { afterEach, beforeEach, describe, test } from "vitest";
import { agentKind } from "../../agents/agentLibrary.ts";
import { setAgentRuntimeSourcesForTests } from "../../agents/agentRuntime.ts";
import { git } from "../../gitExec.ts";
import { LibraryStore } from "../../library/libraryStore.ts";
import type { AgentTool, ToolCallContext } from "../../mcp/tool.ts";
import {
  approvalsForSession,
  resolveApproval,
} from "../../pendingApprovals.ts";
import {
  agentLibraryTools,
  setAgentToolLibraryForTests,
} from "./agentLibraryTools.ts";

let root: string;
let store: LibraryStore;
let sessionId: string;
let run = 0;

function ctx(): ToolCallContext {
  return {
    toolCallId: `tool-${run}`,
    session: {
      sessionId,
      harness: "pi",
      agentType: "developer",
      title: "Agent tools test",
    },
  };
}

function tool(name: string): AgentTool {
  const found = agentLibraryTools.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} must be registered`);
  return found;
}

async function call(name: string, params: Record<string, unknown>) {
  const result = await tool(name).execute(params, ctx());
  const block = result.content[0];
  return {
    result,
    text: block?.type === "text" ? block.text : "",
  };
}

function model(provider: string, id: string): ModelOption {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    supportedThinkingLevels: ["off", "low", "medium", "high"],
    contextWindow: 200_000,
  };
}

const definition = {
  name: "test-reviewer",
  description: "Checks that new tests fail without the code change.",
  persona: "developer",
  model: "sonnet",
  effort: "medium",
  denyTools: ["worktree_push"],
  body: "You are a test reviewer.",
  reason: "Add test-reviewer agent",
};

const latestCard = () => approvalsForSession(sessionId).at(-1)!;
const manifest = () => join(root, "test-reviewer", "AGENT.md");
const headSubject = async () =>
  (await git(["log", "-1", "--format=%s"], root)).stdout.trim();

/** Propose the definition and approve the card, as the user would. */
async function createApproved(): Promise<void> {
  await call("agent_create", definition);
  const { card } = await resolveApproval(latestCard().id, "approved");
  assert.equal(card.status, "executed", card.resultSummary ?? card.error);
}

beforeEach(async () => {
  run += 1;
  sessionId = `sess-agents-${run}`;
  root = mkdtempSync(join(tmpdir(), "agent-tools-test-"));
  store = new LibraryStore(agentKind, root);
  await store.ensureInitialized();
  setAgentToolLibraryForTests(() => store);
  setAgentRuntimeSourcesForTests({
    models: async () => [
      model("claude-sdk", "opus"),
      model("claude-sdk", "sonnet"),
    ],
    skillNames: async () => [],
    toolNames: async () => ["worktree_push", "worktree_commit"],
  });
});

afterEach(() => {
  setAgentToolLibraryForTests(null);
  setAgentRuntimeSourcesForTests(null);
  rmSync(root, { recursive: true, force: true });
});

describe("agent_create", () => {
  test("proposes a card naming the resolved model and writes nothing", async () => {
    const { result, text } = await call("agent_create", definition);
    assert.equal(result.terminate, true);
    assert.match(text, /pending the user's approval/);
    assert.match(text, /claude-sdk\/sonnet/);
    assert.equal(existsSync(manifest()), false);

    const card = latestCard();
    assert.equal(card.status, "pending");
    assert.equal(card.body.kind, "agentDefinition");
    if (card.body.kind !== "agentDefinition") return;
    assert.equal(card.body.action, "create");
    assert.equal(card.body.resolvedModel, "claude-sdk/sonnet");
    assert.match(card.body.source, /^---\nname: test-reviewer\n/);
  });

  test("the card shows the effort the model will actually run at", async () => {
    await call("agent_create", { ...definition, effort: "max" });
    const card = latestCard();
    assert.equal(card.body.kind, "agentDefinition");
    if (card.body.kind !== "agentDefinition") return;
    assert.equal(card.body.effort.after, "max");
    assert.equal(card.body.effort.effective, "high");
  });

  test("approval refuses when the model would now run at another effort than the card showed", async () => {
    await call("agent_create", { ...definition, effort: "max" });
    const createCard = latestCard();
    // The model's supported levels change while the card waits.
    const widened: ModelOption = {
      ...model("claude-sdk", "sonnet"),
      supportedThinkingLevels: ["off", "low", "medium", "high", "max"],
    };
    setAgentRuntimeSourcesForTests({
      models: async () => [model("claude-sdk", "opus"), widened],
      skillNames: async () => [],
      toolNames: async () => ["worktree_push", "worktree_commit"],
    });
    const { card } = await resolveApproval(createCard.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(
      card.error ?? "",
      /would now run "test-reviewer" at effort max, not the high this card showed/,
    );
    assert.equal(existsSync(manifest()), false);
  });

  test("approval writes exactly the proposed definition as one commit", async () => {
    await call("agent_create", definition);
    const proposed = latestCard();
    const { card } = await resolveApproval(proposed.id, "approved");
    assert.equal(card.status, "executed", card.error);
    assert.equal(
      card.body.kind === "agentDefinition" &&
        readFileSync(manifest(), "utf8") === card.body.source,
      true,
    );
    assert.equal(await headSubject(), "Add test-reviewer agent");
    const trailers = (
      await git(["log", "-1", "--format=%(trailers:only)"], root)
    ).stdout;
    assert.match(trailers, /Agent-Names: test-reviewer/);
    assert.match(trailers, /Agent-Session: sess-agents-/);
  });

  test("a model no connected account offers is refused before any card", async () => {
    await assert.rejects(
      tool("agent_create").execute({ ...definition, model: "gemini" }, ctx()),
      /No enabled account offers a model "gemini"/,
    );
    assert.equal(approvalsForSession(sessionId).length, 0);
  });

  test("a definition past the size bound is refused before any card", async () => {
    await assert.rejects(
      tool("agent_create").execute(
        { ...definition, body: "x".repeat(agentKind.maxManifestBytes!) },
        ctx(),
      ),
      /would be \d+ bytes, above the 16384-byte limit for an agent manifest/,
    );
    assert.equal(approvalsForSession(sessionId).length, 0);
  });

  test("an invalid definition is refused before any card", async () => {
    await assert.rejects(
      tool("agent_create").execute(
        { ...definition, persona: "assistant", skills: ["castlabs-ui"] },
        ctx(),
      ),
      /skills may be set only for persona developer/,
    );
    await assert.rejects(
      tool("agent_create").execute(
        { ...definition, denyTools: ["no_such_tool"] },
        ctx(),
      ),
      /tools\.deny names no_such_tool/,
    );
    assert.equal(approvalsForSession(sessionId).length, 0);
  });
});

describe("agent_edit", () => {
  test("an edit that keeps model and effort commits directly", async () => {
    await createApproved();
    const before = approvalsForSession(sessionId).length;
    const { text } = await call("agent_edit", {
      name: "test-reviewer",
      edits: [
        {
          oldText: "You are a test reviewer.",
          newText: "You are a strict test reviewer.",
        },
      ],
      reason: "Sharpen test-reviewer",
    });
    assert.equal(JSON.parse(text).capability, "agent_edit");
    assert.match(readFileSync(manifest(), "utf8"), /strict test reviewer/);
    assert.equal(await headSubject(), "Sharpen test-reviewer");
    assert.equal(approvalsForSession(sessionId).length, before);
  });

  test("an edit that changes the model or effort becomes a card, then applies on approval", async () => {
    await createApproved();
    const original = readFileSync(manifest(), "utf8");
    const { result, text } = await call("agent_edit", {
      name: "test-reviewer",
      edits: [
        { oldText: 'model: "sonnet"', newText: 'model: "opus"' },
        { oldText: "effort: medium", newText: "effort: high" },
      ],
      reason: "Run test-reviewer on Opus",
    });
    assert.equal(result.terminate, true);
    assert.match(
      text,
      /model sonnet → opus \(claude-sdk\/opus\), effort medium → high/,
    );
    assert.equal(readFileSync(manifest(), "utf8"), original);

    const { card } = await resolveApproval(latestCard().id, "approved");
    assert.equal(card.status, "executed", card.error);
    assert.match(
      readFileSync(manifest(), "utf8"),
      /model: "opus"\neffort: high/,
    );
    assert.equal(await headSubject(), "Run test-reviewer on Opus");
  });

  test("approval refuses when the file no longer comes out at the approved runtime", async () => {
    await createApproved();
    await call("agent_edit", {
      name: "test-reviewer",
      edits: [{ oldText: "effort: medium", newText: "effort: high" }],
      reason: "Raise effort",
    });
    const pending = latestCard();
    // The user changes the model by hand and commits it before approving.
    await writeFile(
      manifest(),
      readFileSync(manifest(), "utf8").replace('"sonnet"', '"opus"'),
    );
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-am",
        "Hand edit",
      ],
      root,
    );
    const { card } = await resolveApproval(pending.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(
      card.error ?? "",
      /no longer produce exactly the AGENT\.md the card showed/,
    );
    assert.match(readFileSync(manifest(), "utf8"), /effort: medium/);
  });

  test("approval applies only the exact AGENT.md the card showed", async () => {
    await createApproved();
    await call("agent_edit", {
      name: "test-reviewer",
      edits: [{ oldText: 'model: "sonnet"', newText: 'model: "opus"' }],
      reason: "Run on Opus",
    });
    const pending = latestCard();
    // A hand edit to the instructions only: model and effort still match.
    await writeFile(
      manifest(),
      readFileSync(manifest(), "utf8").replace(
        "You are a test reviewer.",
        "You are a test reviewer. Be brief.",
      ),
    );
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-am",
        "Hand edit",
      ],
      root,
    );
    const { card } = await resolveApproval(pending.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(card.error ?? "", /the AGENT\.md the card showed/);
    assert.match(readFileSync(manifest(), "utf8"), /model: "sonnet"/);
  });

  test("an edit may not change the declared name, so a card cannot address another entry", async () => {
    await createApproved();
    await call("agent_create", {
      ...definition,
      name: "other",
      body: "Unrelated.\nname: test-reviewer\n",
      reason: "Add other",
    });
    await resolveApproval(latestCard().id, "approved");
    const other = readFileSync(join(root, "other", "AGENT.md"), "utf8");
    const cards = approvalsForSession(sessionId).length;
    await assert.rejects(
      tool("agent_edit").execute(
        {
          name: "test-reviewer",
          edits: [
            { oldText: "name: test-reviewer", newText: "name: other" },
            { oldText: 'model: "sonnet"', newText: 'model: "opus"' },
          ],
          reason: "Retarget",
        },
        ctx(),
      ),
      /may not change the declared name \("test-reviewer" → "other"\)/,
    );
    assert.equal(approvalsForSession(sessionId).length, cards);
    assert.equal(readFileSync(join(root, "other", "AGENT.md"), "utf8"), other);
  });

  test("approval refuses when the model now resolves to another connected model", async () => {
    await createApproved();
    await call("agent_edit", {
      name: "test-reviewer",
      edits: [{ oldText: "effort: medium", newText: "effort: high" }],
      reason: "Raise effort",
    });
    const pending = latestCard();
    // The Claude account went away; another provider now offers "sonnet".
    setAgentRuntimeSourcesForTests({
      models: async () => [model("anthropic", "sonnet")],
      skillNames: async () => [],
      toolNames: async () => ["worktree_push", "worktree_commit"],
    });
    const { card } = await resolveApproval(pending.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(
      card.error ?? "",
      /now resolves to anthropic\/sonnet, not the claude-sdk\/sonnet this card showed/,
    );
    assert.match(readFileSync(manifest(), "utf8"), /effort: medium/);
  });

  test("an edit card refuses when the effective effort drifted while it waited", async () => {
    await createApproved();
    await call("agent_edit", {
      name: "test-reviewer",
      edits: [{ oldText: "effort: medium", newText: "effort: max" }],
      reason: "Max effort",
    });
    const pending = latestCard();
    assert.equal(
      pending.body.kind === "agentDefinition" && pending.body.effort.effective,
      "high",
    );
    setAgentRuntimeSourcesForTests({
      models: async () => [
        model("claude-sdk", "opus"),
        {
          ...model("claude-sdk", "sonnet"),
          supportedThinkingLevels: ["off", "low", "medium", "high", "max"],
        },
      ],
      skillNames: async () => [],
      toolNames: async () => ["worktree_push", "worktree_commit"],
    });
    const { card } = await resolveApproval(pending.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(
      card.error ?? "",
      /at effort max, not the high this card showed/,
    );
    assert.match(readFileSync(manifest(), "utf8"), /effort: medium/);
  });

  test("an edit that breaks the runtime check is refused and changes nothing", async () => {
    await createApproved();
    const original = readFileSync(manifest(), "utf8");
    await assert.rejects(
      tool("agent_edit").execute(
        {
          name: "test-reviewer",
          edits: [{ oldText: "worktree_push", newText: "worktree_pusj" }],
          reason: "Typo",
        },
        ctx(),
      ),
      /tools\.deny names worktree_pusj/,
    );
    assert.equal(readFileSync(manifest(), "utf8"), original);
    assert.equal(
      (await git(["status", "--porcelain"], root)).stdout.trim(),
      "",
    );
  });
});

describe("the agent tool group", () => {
  test("is the shared factory's ten tools under the agent prefix", () => {
    assert.deepEqual(
      agentLibraryTools.map((candidate) => candidate.name),
      [
        "agent_list",
        "agent_get",
        "agent_read_file",
        "agent_create",
        "agent_edit",
        "agent_manage_files",
        "agent_rename",
        "agent_delete",
        "agent_history",
        "agent_diff",
      ],
    );
    assert.match(tool("agent_list").description, /`agentCount`/);
    assert.match(tool("agent_edit").description, /approval card/);
  });
});

describe("agent tool races and pins", () => {
  const handCommit = async (message: string) =>
    git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-am",
        message,
      ],
      root,
    );

  test("a re-proposed create supersedes the waiting card, and a taken name is refused before any card", async () => {
    await call("agent_create", definition);
    const first = latestCard();
    await call("agent_create", { ...definition, reason: "Add again" });
    const second = latestCard();
    assert.notEqual(first.id, second.id);
    assert.equal(
      approvalsForSession(sessionId).find((card) => card.id === first.id)
        ?.status,
      "superseded",
    );
    await assert.rejects(
      resolveApproval(first.id, "approved"),
      /already superseded/,
    );
    const { card } = await resolveApproval(second.id, "approved");
    assert.equal(card.status, "executed", card.error);
    const cards = approvalsForSession(sessionId).length;
    await assert.rejects(
      tool("agent_create").execute(definition, ctx()),
      /already has an entry or folder named "test-reviewer"/,
    );
    assert.equal(approvalsForSession(sessionId).length, cards);
  });

  test("a card created in another session refuses on approval once the name is taken", async () => {
    await call("agent_create", definition);
    const waiting = latestCard();
    const otherSession = sessionId;
    sessionId = `${sessionId}-other`;
    await createApproved();
    sessionId = otherSession;
    const { card } = await resolveApproval(waiting.id, "approved");
    assert.equal(card.status, "failed");
    assert.match(card.error ?? "", /already declares the name "test-reviewer"/);
  });

  test("a pinned Claude id shows the version it holds the alias to", async () => {
    setAgentRuntimeSourcesForTests({
      models: async () => [
        { ...model("claude-sdk", "opus"), pinnedId: "claude-opus-5-5" },
      ],
      skillNames: async () => [],
      toolNames: async () => ["worktree_push"],
    });
    await call("agent_create", {
      ...definition,
      name: "qualified",
      model: "claude-sdk/claude-opus-5-5",
    });
    assert.equal(
      latestCard().body.kind === "agentDefinition" &&
        (latestCard().body as { resolvedModel: string }).resolvedModel,
      "claude-sdk/opus (claude-opus-5-5)",
    );
    await call("agent_create", { ...definition, model: "claude-opus-5-5" });
    const card = latestCard();
    assert.equal(
      card.body.kind === "agentDefinition" && card.body.resolvedModel,
      "claude-sdk/opus (claude-opus-5-5)",
    );
    const { card: done } = await resolveApproval(card.id, "approved");
    assert.equal(done.status, "executed", done.error);
    assert.match(readFileSync(manifest(), "utf8"), /model: "claude-opus-5-5"/);
  });

  test("a direct edit refuses when the locked file would now change the model", async () => {
    await createApproved();
    // Preview: the edit only touches the body.
    await writeFile(
      manifest(),
      readFileSync(manifest(), "utf8").replace(
        "You are a test reviewer.",
        "You are a test reviewer for sonnet-fans.",
      ),
    );
    await handCommit("Body mentions sonnet-fans");
    let armed = true;
    class RacingStore extends LibraryStore {
      override async commitMutation<T>(
        ...args: Parameters<LibraryStore["commitMutation"]>
      ): Promise<{ value: T; commit: never; status: never }> {
        if (armed) {
          armed = false;
          // Between the preview and the locked write, the target text moves
          // into the model line.
          await writeFile(
            manifest(),
            readFileSync(manifest(), "utf8")
              .replace('model: "sonnet"', 'model: "sonnet-fans"')
              .replace(" for sonnet-fans.", "."),
          );
          await handCommit("Model is now sonnet-fans");
        }
        return super.commitMutation(...(args as [never, never])) as never;
      }
    }
    const racing = new RacingStore(agentKind, root);
    setAgentToolLibraryForTests(() => racing);
    await assert.rejects(
      tool("agent_edit").execute(
        {
          name: "test-reviewer",
          edits: [{ oldText: "sonnet-fans", newText: "opus-fans" }],
          reason: "Retarget fans",
        },
        ctx(),
      ),
      /changed since this edit was checked, and the edit would now change its model or effort/,
    );
    assert.equal(armed, false);
    assert.match(readFileSync(manifest(), "utf8"), /model: "sonnet-fans"/);
  });

  test("a hand edit made while the locked check awaits is refused, not overwritten", async () => {
    await createApproved();
    let armed = true;
    setAgentRuntimeSourcesForTests({
      models: async () => [
        model("claude-sdk", "opus"),
        model("claude-sdk", "sonnet"),
      ],
      skillNames: async () => [],
      // Called inside the locked check (the definition denies a tool).
      toolNames: async () => {
        if (armed) {
          armed = false;
          await writeFile(
            manifest(),
            readFileSync(manifest(), "utf8").replace(
              'model: "sonnet"',
              'model: "opus"',
            ),
          );
        }
        return ["worktree_push", "worktree_commit"];
      },
    });
    await assert.rejects(
      tool("agent_edit").execute(
        {
          name: "test-reviewer",
          edits: [
            {
              oldText: "You are a test reviewer.",
              newText: "You are a careful test reviewer.",
            },
          ],
          reason: "Careful",
        },
        ctx(),
      ),
      /changed while the edit was being checked/,
    );
    assert.equal(armed, false, "the hand edit landed inside the check");
    const now = readFileSync(manifest(), "utf8");
    assert.match(now, /model: "opus"/, "the hand edit is kept");
    assert.doesNotMatch(now, /careful test reviewer/);
  });
});
