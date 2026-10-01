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

    expect(html).toContain("Answered");
    expect(html).toContain("Yes");
    expect(html).not.toContain("Question 1 of 2");
  });
});
