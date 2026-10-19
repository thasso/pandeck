import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  AgentQuestionRequest,
  AnsweredAgentQuestion,
  DisplayBlock,
  DisplayMessage,
} from "@assistant/shared";
import {
  AgentQuestionToolCard,
  pendingQuestionEntryId,
  questionFlowForBlock,
} from "./AgentQuestionToolCard.tsx";

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
        pendingQuestions={[pending]}
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
        pendingQuestions={[
          {
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
          },
        ]}
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

  it("gives each of several pending flows its own form", () => {
    const alpha = {
      ...pending,
      requestId: "question-a",
      toolCallId: "toolu_A",
      title: "Alpha",
    };
    const beta = {
      ...pending,
      requestId: "question-b",
      toolCallId: "toolu_B",
      title: "Beta",
    };
    const html = renderToStaticMarkup(
      <AgentQuestionToolCard
        block={{
          ...block,
          toolId: "toolu_B",
          args: { ...(block.args as object), title: "Beta" },
        }}
        pendingQuestions={[alpha, beta]}
        onRespond={() => {}}
      />,
    );

    expect(html).toContain("Beta");
    expect(html).not.toContain("Alpha");
    expect(html).toContain("Question 1 of 2");
  });

  it("prefers a flow posted by this exact tool call over a payload match", () => {
    // Same title and questions: only the relinked tool-call id tells them apart.
    const byShape = {
      ...pending,
      requestId: "question-shape",
      toolCallId: "3",
    };
    const exact = {
      ...pending,
      requestId: "question-exact",
      toolCallId: block.toolId,
    };

    expect(
      questionFlowForBlock([byShape, exact], undefined, block)?.pending
        ?.requestId,
    ).toBe("question-exact");
    expect(
      questionFlowForBlock([byShape], undefined, block)?.pending?.requestId,
    ).toBe("question-shape");
    expect(questionFlowForBlock([], [], block)).toBeUndefined();
  });

  it("shows a new flow's form even beside an earlier answer of the same shape", () => {
    // An answer recorded before relinking keeps the MCP id, so it still
    // matches this block's payload; the new flow's exact id must win.
    const earlier: AnsweredAgentQuestion = {
      ...pending,
      requestId: "question-old",
      toolCallId: "1",
      response: {
        requestId: "question-old",
        status: "submitted",
        submittedAt: 2,
        answers: [],
      },
    };
    const current = {
      ...pending,
      requestId: "question-new",
      toolCallId: block.toolId,
    };
    const html = renderToStaticMarkup(
      <AgentQuestionToolCard
        block={block}
        pendingQuestions={[current]}
        answeredQuestions={[earlier]}
        onRespond={() => {}}
      />,
    );

    expect(html).toContain("Question 1 of 2");
    expect(html).not.toContain("Question answered");
    const row = { id: "m1", role: "assistant", blocks: [block] };
    expect(
      pendingQuestionEntryId(
        [row as unknown as DisplayMessage],
        [current],
        [earlier],
        current,
      ),
    ).toBe("m1");
  });

  it("finds the transcript row holding each pending flow's form", () => {
    const alpha = {
      ...pending,
      requestId: "question-a",
      toolCallId: "toolu_A",
    };
    const beta = { ...pending, requestId: "question-b", toolCallId: "toolu_B" };
    const row = (id: string, toolId: string) =>
      ({
        id,
        role: "assistant",
        blocks: [{ ...block, toolId }],
      }) as unknown as DisplayMessage;
    const messages = [row("m1", "toolu_A"), row("m2", "toolu_B")];

    expect(pendingQuestionEntryId(messages, [alpha, beta], [], alpha)).toBe(
      "m1",
    );
    expect(pendingQuestionEntryId(messages, [alpha, beta], [], beta)).toBe(
      "m2",
    );
    expect(
      pendingQuestionEntryId(messages, [alpha, beta], [], {
        ...pending,
        requestId: "question-gone",
        toolCallId: "toolu_gone",
      }),
    ).toBeUndefined();
  });
});
