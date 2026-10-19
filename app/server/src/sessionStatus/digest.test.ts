import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "vitest";
import { pullRequestCardStore } from "../db/pullRequestCardStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { taskStore } from "../db/taskStore.ts";
import { canonicalSessionLogPath } from "../sessionStorage.ts";
import { buildSessionDigest, DIGEST_END_MARKER } from "./digest.ts";

let seq = 0;
const at = (minute: number) =>
  new Date(Date.UTC(2026, 9, 8, 15, minute)).toISOString();

function writeLog(sessionId: string, rows: object[]): void {
  const path = canonicalSessionLogPath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [{ v: 1, sessionId, createdAt: at(0) }, ...rows]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
}

function session(title: string): string {
  const id = `status-${seq++}`;
  sessionStore.upsert({
    id,
    harness: "pi",
    agentType: "developer",
    title,
    model: "gpt-6-luna",
  });
  return id;
}

const human = (text: string, minute: number) => ({
  type: "message",
  role: "user",
  origin: { kind: "human" },
  content: [{ type: "text", text }],
  createdAt: at(minute),
});
const assistant = (minute: number, ...content: object[]) => ({
  type: "message",
  role: "assistant",
  content,
  createdAt: at(minute),
});
const run = (type: string, minute: number) => ({
  type,
  runId: `run-${minute}`,
  createdAt: at(minute),
});

describe("buildSessionDigest", () => {
  it("quotes prompts and answers, redacts credentials, and ends with the marker", () => {
    const id = session("STAR-1461: Deploy to test");
    const answers = {
      answers: [
        {
          title: "Check 5 needs arm64 builds",
          choiceLabels: ["Skip check 5 for now"],
          text: "",
        },
      ],
    };
    writeLog(id, [
      run("run.started", 1),
      human(
        [
          'Deploy test. export AWS_ACCESS_KEY_ID="ASIA2UC3BAT77R2S3DGM"',
          "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
          "password=shortpw",
        ].join("\n"),
        1,
      ),
      assistant(
        2,
        {
          type: "toolCall",
          toolCallId: "q1",
          name: "ask_questions",
          input: {
            title: "Two decisions",
            questions: [{ title: "Check 5 needs arm64 builds" }],
          },
        },
        { type: "text", text: "I need two decisions from you." },
      ),
      { type: "message", role: "toolResult", toolCallId: "q1", content: [] },
      run("run.ended", 2),
      run("run.started", 3),
      {
        type: "message",
        role: "user",
        origin: { kind: "system", source: "agent-question-response" },
        content: [
          {
            type: "text",
            text: `[ask_questions: user answers]\nThe user answered.\n\n${JSON.stringify(answers)}`,
          },
        ],
        createdAt: at(3),
      },
      assistant(4, { type: "text", text: "## Done\nTest is deployed." }),
      run("run.ended", 4),
    ]);
    const meta = sessionStore.get(id)!;

    const { prompt: digest, sourceSessionIds } = buildSessionDigest(
      meta,
      Date.UTC(2026, 9, 8, 16),
    );
    assert.deepEqual(sourceSessionIds, [id]);

    assert.match(digest, /^# Session digest: STAR-1461: Deploy to test/);
    assert.match(digest, /- Activity: 2 runs on 1 day\(s\)/);
    assert.match(digest, /Credentials pasted by the user: 1 prompt\(s\)/);
    for (const secret of [
      "ASIA2UC3BAT77R2S3DGM",
      "eyJhbGciOiJIUzI1NiJ9",
      "shortpw",
    ])
      assert.ok(!digest.includes(secret), `${secret} redacted`);
    assert.match(
      digest,
      /\*\*User answered questions:\*\* “Check 5 needs arm64 builds” → Skip check 5 for now/,
    );
    assert.match(digest, /asked the user: Two decisions/);
    // A quoted heading must not read as a digest section.
    assert.ok(!digest.includes("## Done"));
    assert.match(digest, /\*\*Agent \(final reply of run\):\*\* Done\nTest/);
    assert.ok(digest.trimEnd().endsWith(DIGEST_END_MARKER));
  });

  it("summarizes a session_send_prompt call's rows, tolerating malformed ones", () => {
    const id = session("Coordinator");
    writeLog(id, [
      run("run.started", 1),
      human("Report back to the reviewers.", 1),
      assistant(2, {
        type: "toolCall",
        toolCallId: "s1",
        name: "session_send_prompt",
        input: {
          rows: [
            { targetSessionId: "reviewer-a", prompt: "Fixed, re-check" },
            "not a row",
            { targetSessionId: "reviewer-b", prompt: "Also fixed" },
            { inReplyTo: ["k1"], settle: "applied the body" },
          ],
        },
      }),
      {
        type: "message",
        role: "toolResult",
        toolCallId: "s1",
        content: [{ type: "text", text: "{}" }],
      },
      run("run.ended", 2),
    ]);
    const { prompt: digest } = buildSessionDigest(
      sessionStore.get(id)!,
      Date.UTC(2026, 9, 8, 16),
    );
    assert.match(
      digest,
      /sent peer message to `reviewer-a`, `reviewer-b`: Fixed, re-check \/ Also fixed; settled 1 request row\(s\)/,
    );
  });

  it("reports the Tasks a session created with their sessions' latest outcome", () => {
    const id = session("Labs port");
    writeLog(id, [run("run.started", 1), human("Plan it.", 1)]);
    const task = taskStore.create({
      title: "Establish the local baseline",
      sourceSessionId: id,
    });
    taskStore.setStatus(task.id, "done");
    const worker = session("Task: local baseline");
    taskStore.linkSession(task.id, worker);
    writeLog(worker, [
      run("run.started", 5),
      assistant(6, { type: "text", text: "PR #9 is merged into main." }),
    ]);
    pullRequestCardStore.insert({
      card: {
        renderKind: "pullRequest",
        id: `pr-${seq++}`,
        sessionId: worker,
        status: "merged",
        createdAt: 1,
        updatedAt: 2,
        number: 9,
        url: "https://example.test/pull/9",
        title: "Add the local baseline",
        headBranch: "baseline",
        baseBranch: "main",
        body: ["## Summary\nRuns Labs locally."],
        warnings: [],
      },
      context: {},
    });

    const { prompt: digest, sourceSessionIds } = buildSessionDigest(
      sessionStore.get(id)!,
    );
    assert.deepEqual(sourceSessionIds, [id, worker]);

    assert.match(
      digest,
      new RegExp(`- Task-${task.id} “Establish the local baseline”: done`),
    );
    assert.match(digest, /worked on in “Task: local baseline”/);
    assert.match(
      digest,
      /Latest outcome, from “Task: local baseline”: PR #9 is merged into main\./,
    );
    assert.match(
      digest,
      new RegExp(
        `- merged: #9 “Add the local baseline” .* — via Task-${task.id}`,
      ),
    );
    assert.match(digest, /Description: Runs Labs locally\./);
  });

  it("collapses old runs with neither a user prompt nor a milestone", () => {
    const id = session("Long session");
    const rows: object[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push(run("run.started", i));
      rows.push(
        i === 0
          ? human("Start the work.", i)
          : {
              type: "message",
              role: "user",
              origin: { kind: "agent", agentId: "peer-prompt" },
              peerPrompt: {
                direction: "received",
                senderTitle: "Implementer",
                peerSessionId: "peer",
                message: `Progress ${i}`,
              },
              content: [],
              createdAt: at(i),
            },
      );
      rows.push(assistant(i, { type: "text", text: `Reply ${i}` }));
    }
    writeLog(id, rows);

    const { prompt: digest } = buildSessionDigest(sessionStore.get(id)!);

    assert.match(digest, /### Run 1\/60/);
    assert.match(
      digest,
      /_Runs 2–22: 21 run\(s\) of agent\/peer\/background traffic with no user prompt or milestone, omitted\._/,
    );
    assert.match(digest, /### Run 60\/60/);
  });
});
