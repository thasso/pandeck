import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AgentQuestionRequest,
  AnsweredAgentQuestion,
  DisplayBlock,
} from "@assistant/shared";
import { AgentQuestionToolCard } from "./AgentQuestionToolCard.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

const block: ToolBlock = {
  kind: "tool",
  toolId: "toolu_01Question",
  name: "mcp__pa__ask_questions",
  args: {
    title: "Deployment check",
    questions: [
      {
        id: "runner",
        title: "Runner",
        style: "single_choice",
        choices: [{ id: "yes", label: "Yes" }],
      },
      { id: "label", title: "Label", style: "text" },
    ],
  },
  output: "Posted 2 questions to the user in the app's question panel.",
  isError: false,
  done: true,
};

const pending: AgentQuestionRequest = {
  requestId: "question-1",
  toolCallId: "2",
  sessionId: "session-1",
  title: "Deployment check",
  questions: [
    {
      id: "runner",
      title: "Runner",
      style: "single_choice",
      required: true,
      choices: [{ id: "yes", label: "Yes" }],
      allowTypedAnswer: false,
      defaultChoiceIds: [],
    },
    {
      id: "label",
      title: "Label",
      style: "text",
      required: true,
      allowTypedAnswer: true,
      defaultChoiceIds: [],
    },
  ],
  createdAt: 1,
};

describe("AgentQuestionToolCard", () => {
  it("renders the interactive form for Claude SDK MCP numeric request ids", () => {
    const html = renderToStaticMarkup(
      <AgentQuestionToolCard
        block={block}
        pendingQuestion={pending}
        onRespond={() => {}}
      />,
    );

    expect(html).toContain("Question 1 of 2");
    expect(html).toContain("Next");
    expect(html).not.toContain("Deployment check</span><ul");
  });

  it("renders agent-written fields as Markdown", () => {
    const html = renderToStaticMarkup(
      <AgentQuestionToolCard
        block={block}
        pendingQuestion={{
          ...pending,
          toolCallId: block.toolId,
          title: "Task → `Initiative` membership",
          intro: "**Objective:** ship it.\n\n1. Query\n2. Context",
          questions: [
            {
              ...pending.questions[0]!,
              title: "Keep `TaskItem` current",
              prompt: "Should a change *notify*?",
              helpText: "See `holdersOf`.",
              choices: [
                {
                  id: "yes",
                  label: "Yes, **notify**",
                  description: "Correct.\n\n- live\n- scales",
                },
              ],
            },
            pending.questions[1]!,
          ],
        }}
        onRespond={() => {}}
      />,
    );

    expect(html).toContain("Task → <code>Initiative</code> membership");
    expect(html).toContain("<strong>Objective:</strong> ship it.");
    expect(html).toContain("<li>Query</li>");
    expect(html).toContain("Keep <code>TaskItem</code> current");
    expect(html).toContain("<em>notify</em>");
    expect(html).toContain("See <code>holdersOf</code>.");
    expect(html).toContain("Yes, <strong>notify</strong>");
    expect(html).toContain("<li>scales</li>");
    expect(html).not.toContain("**");
  });

  it("renders recorded answers for Claude SDK MCP numeric request ids", () => {
    const answered: AnsweredAgentQuestion = {
      ...pending,
      response: {
        requestId: pending.requestId,
        status: "submitted",
        submittedAt: 2,
        answers: [
          {
            questionId: "runner",
            choiceIds: ["yes"],
            text: "",
            disposition: "answered",
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <AgentQuestionToolCard block={block} answeredQuestions={[answered]} />,
    );

    expect(html).toContain("Question answered");
    expect(html).toContain("Yes");
    // A question the response left out says so rather than vanishing.
    expect(html).toContain("No answer");
    expect(html).not.toContain("Question 1 of 2");
  });
});
