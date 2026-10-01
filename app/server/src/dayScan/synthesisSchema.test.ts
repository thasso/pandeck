import assert from "node:assert/strict";
import { test } from "vitest";
import { renderNarrative, validateSynthesisResult } from "./synthesisSchema.ts";

test("valid structured result passes and normalizes", () => {
  const res = validateSynthesisResult({
    sections: [
      {
        id: "needs-attention",
        markdown:
          "Review [PR](https://github.com/x/y/pull/1) and see [issue](pa://task/5).",
      },
      { id: "my-day", markdown: "Standup at 10." },
    ],
    taskProposals: [{ candidateId: "mc_abc", title: "Ship it", accept: true }],
    threadProposals: [
      {
        threadId: null,
        title: "SSAI rollout",
        state: "active",
        issueKeys: ["WEB-1"],
        summary: "ongoing",
        baseRevision: 0,
      },
    ],
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.result.sections.length, 2);
    assert.equal(res.result.taskProposals[0]?.candidateId, "mc_abc");
  }
});

test("unknown section id is rejected", () => {
  const res = validateSynthesisResult({
    sections: [{ id: "totally-made-up", markdown: "x" }],
    taskProposals: [],
    threadProposals: [],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.ok(res.errors.some((e) => /Unknown section id/.test(e)));
});

test("links are trusted: any host (Calendar/Slack/etc.) is accepted", () => {
  const res = validateSynthesisResult({
    sections: [
      {
        id: "projects",
        markdown:
          "See [event](https://www.google.com/calendar/event?eid=abc) and [msg](https://acme.slack.com/archives/C1/p1).",
      },
    ],
    taskProposals: [],
    threadProposals: [],
  });
  assert.equal(res.ok, true);
});

test("a thread proposal without an integer baseRevision is rejected", () => {
  const res = validateSynthesisResult({
    sections: [],
    taskProposals: [],
    threadProposals: [
      {
        threadId: null,
        title: "x",
        state: "active",
        issueKeys: [],
        summary: "",
      },
    ],
  });
  assert.equal(res.ok, false);
});

test("renderNarrative emits sections in presentation order with titles", () => {
  const md = renderNarrative([
    { id: "projects", markdown: "project stuff" },
    { id: "needs-attention", markdown: "urgent stuff" },
  ]);
  assert.ok(
    md.indexOf("Needs your attention") < md.indexOf("Projects"),
    "attention leads, projects follow",
  );
});
