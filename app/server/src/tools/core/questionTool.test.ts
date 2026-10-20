import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import type { AgentQuestionRequest } from "@assistant/shared";
import { DATA_DIR } from "../../config.ts";
import type { ToolCallContext } from "../../mcp/tool.ts";

const notifySessionBlocked = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => {}),
);
vi.mock("../../webPush.ts", () => ({ notifySessionBlocked }));

const PENDING_FILE = join(DATA_DIR, "pending-questions.json");

type QuestionModule = typeof import("./questionTool.ts");
let questions: QuestionModule;

/** A fresh module, so its pending store is read from disk as at startup. */
async function load(): Promise<QuestionModule> {
  vi.resetModules();
  questions = await import("./questionTool.ts");
  return questions;
}

async function ask(
  sessionId: string,
  toolCallId: string,
  title: string,
): Promise<{ requestId: string; text: string }> {
  const result = await questions.askQuestionsTool.execute(
    { title, questions: [{ id: "pick", title: "Pick one", style: "text" }] },
    { session: { sessionId }, toolCallId } as unknown as ToolCallContext,
  );
  const [block] = result.content;
  const text = block && "text" in block ? block.text : "";
  const requestId = (result.details as { requestId: string }).requestId;
  return { requestId, text };
}

function answer(sessionId: string, requestId: string, text: string) {
  return questions.submitAgentQuestionResponse(sessionId, {
    requestId,
    status: "submitted",
    answers: [{ questionId: "pick", text, disposition: "answered" }],
    submittedAt: 1,
  });
}

beforeEach(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PENDING_FILE, "{}\n");
  notifySessionBlocked.mockClear();
  await load();
});

describe("ask_questions with several open flows", () => {
  test("holds each flow, and names the earlier ones in a later result", async () => {
    const first = await ask("s1", "call-1", "Planner A");
    const second = await ask("s1", "call-2", "Planner B");

    assert.deepEqual(
      questions.getPendingAgentQuestions("s1").map((q) => q.requestId),
      [first.requestId, second.requestId],
    );
    assert.equal(questions.hasPendingAgentQuestion("s1"), true);
    assert.match(
      first.text,
      new RegExp(`as flow ${first.requestId} \\("Planner A"\\)\\.`),
    );
    assert.doesNotMatch(first.text, /Also still open/);
    assert.match(
      second.text,
      new RegExp(`Also still open: ${first.requestId} \\("Planner A"\\)\\.`),
    );
    assert.match(second.text, /STOP HERE: end your turn now/);
    assert.match(first.text, /Cancelling a flow closes it silently/);
    assert.doesNotMatch(first.text, /answers \(or a cancellation\)/);
  });

  test("answering one flow resumes with its own answers and leaves the rest", async () => {
    const first = await ask("s1", "call-1", "Planner A");
    const second = await ask("s1", "call-2", "Planner B");

    const { resumePrompt } = answer("s1", second.requestId, "go with B");
    assert.ok(resumePrompt);
    assert.match(
      resumePrompt,
      new RegExp(`question flow ${second.requestId} \\("Planner B"\\)`),
    );
    assert.match(
      resumePrompt,
      new RegExp(
        `Still waiting on the user: ${first.requestId} \\("Planner A"\\)`,
      ),
    );
    assert.match(resumePrompt, /go with B/);
    assert.deepEqual(
      questions.getPendingAgentQuestions("s1").map((q) => q.requestId),
      [first.requestId],
    );
    assert.deepEqual(
      questions.getAnsweredAgentQuestions("s1").map((a) => a.requestId),
      [second.requestId],
    );

    const last = answer("s1", first.requestId, "go with A");
    assert.doesNotMatch(last.resumePrompt ?? "", /Still waiting/);
    assert.equal(questions.hasPendingAgentQuestion("s1"), false);
    assert.deepEqual(questions.getPendingAgentQuestions("s1"), []);
  });

  test("cancelling one flow keeps the other pending and resumes nothing", async () => {
    const first = await ask("s1", "call-1", "Planner A");
    const second = await ask("s1", "call-2", "Planner B");

    const { resumePrompt } = questions.submitAgentQuestionResponse("s1", {
      requestId: first.requestId,
      status: "cancelled",
      answers: [],
      submittedAt: 1,
    });
    assert.equal(resumePrompt, undefined);
    assert.deepEqual(
      questions.getPendingAgentQuestions("s1").map((q) => q.requestId),
      [second.requestId],
    );
  });

  test("refuses a response naming no pending flow", async () => {
    await ask("s1", "call-1", "Planner A");
    assert.throws(
      () => answer("s1", "question-0-nothing", "x"),
      /does not match a pending question flow/,
    );
    assert.equal(questions.getPendingAgentQuestions("s1").length, 1);
  });

  test("caps the open flows of one session, not of others", async () => {
    for (let i = 0; i < 8; i += 1) await ask("s1", `call-${i}`, `Flow ${i}`);
    await assert.rejects(
      ask("s1", "call-9", "One too many"),
      /already has 8 unanswered question flows/,
    );
    assert.equal(questions.getPendingAgentQuestions("s1").length, 8);
    await ask("s2", "call-x", "Elsewhere");
    assert.equal(questions.getPendingAgentQuestions("s2").length, 1);
  });

  test("pushes once while any flow is open", async () => {
    const first = await ask("s1", "call-1", "Planner A");
    await ask("s1", "call-2", "Planner B");
    assert.equal(notifySessionBlocked.mock.calls.length, 1);
    assert.deepEqual(notifySessionBlocked.mock.calls[0], [
      "s1",
      "question",
      "Planner A",
    ]);

    answer("s1", first.requestId, "a");
    await ask("s1", "call-3", "Planner C");
    assert.equal(notifySessionBlocked.mock.calls.length, 1);
  });

  test("a restart restores every open flow", async () => {
    const first = await ask("s1", "call-1", "Planner A");
    const second = await ask("s1", "call-2", "Planner B");
    const stored = JSON.parse(readFileSync(PENDING_FILE, "utf8")) as Record<
      string,
      AgentQuestionRequest[]
    >;
    assert.deepEqual(
      stored.s1?.map((q) => q.requestId),
      [first.requestId, second.requestId],
    );

    await load();
    assert.deepEqual(
      questions.getPendingAgentQuestions("s1").map((q) => q.requestId),
      [first.requestId, second.requestId],
    );
    assert.ok(answer("s1", first.requestId, "a").resumePrompt);
  });

  test("a file from before several flows still restores its question", async () => {
    const request: AgentQuestionRequest = {
      requestId: "question-1-legacy",
      toolCallId: "call-1",
      sessionId: "s1",
      title: "Old flow",
      questions: [],
      createdAt: 1,
    };
    writeFileSync(PENDING_FILE, JSON.stringify({ s1: request }));
    await load();
    assert.deepEqual(questions.getPendingAgentQuestions("s1"), [request]);
  });

  test("relinks the flow a tool result names to the provider's tool-use id", async () => {
    const first = await ask("s1", "1", "Planner A");
    const second = await ask("s1", "2", "Planner B");

    const named = questions.questionRequestIdFromToolResult(second.text);
    assert.equal(named, second.requestId);
    assert.equal(
      questions.relinkAgentQuestionToolCallId("s1", named!, "toolu_B"),
      true,
    );
    assert.deepEqual(
      questions
        .getPendingAgentQuestions("s1")
        .map((q) => [q.requestId, q.toolCallId]),
      [
        [first.requestId, "1"],
        [second.requestId, "toolu_B"],
      ],
    );
    assert.equal(questions.questionRequestIdFromToolResult("{}"), undefined);
  });
});
