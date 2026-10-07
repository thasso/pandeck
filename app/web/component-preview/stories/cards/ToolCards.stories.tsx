import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentQuestionToolCard } from "../../../src/components/AgentQuestionToolCard.tsx";
import { KnowledgeEntryToolCard } from "../../../src/components/KnowledgeEntryToolCard.tsx";
import { KnowledgeOpenTargetsProvider } from "../../../src/components/KnowledgeOpenTargets.tsx";
import { ServedFileCard } from "../../../src/components/ServedFileCard.tsx";
import { TaskManageToolCard } from "../../../src/components/TaskManageToolCard.tsx";
import { WorkshopDraftHandoffToolCard } from "../../../src/components/WorkshopDraftHandoffCard.tsx";
import { WorktreeProvisionCard } from "../../../src/components/WorktreeProvisionCard.tsx";
import {
  answeredQuestion,
  knowledgeEntry,
  questionBlock,
  questionRequest,
  taskManageBlock,
  workshopHandoffBlock,
  worktreeProvisions,
} from "../../fixtures/cards.ts";

type ToolSurface = "results" | "questions";

export interface ToolCardsStoryProps {
  frameWidth: number;
  surface: ToolSurface;
}

const targets = { openInPanel: () => {}, openInMain: () => {} };

/** The small tool cards a transcript shows in band, in their main states. */
export function ToolCardsStory({ frameWidth, surface }: ToolCardsStoryProps) {
  return (
    <KnowledgeOpenTargetsProvider targets={targets}>
      <div className="bg-background p-4" style={{ width: frameWidth }}>
        {surface === "questions" ? (
          <>
            <AgentQuestionToolCard
              block={questionBlock}
              pendingQuestion={questionRequest}
              onRespond={() => {}}
            />
            <AgentQuestionToolCard
              block={questionBlock}
              answeredQuestions={[answeredQuestion]}
            />
            <AgentQuestionToolCard
              block={questionBlock}
              answeredQuestions={[
                {
                  ...answeredQuestion,
                  response: {
                    ...answeredQuestion.response,
                    status: "cancelled",
                    answers: [],
                  },
                },
              ]}
            />
            {/* No live flow and no recorded answer: the tool args only. */}
            <AgentQuestionToolCard block={questionBlock} />
          </>
        ) : (
          <>
            <KnowledgeEntryToolCard card={knowledgeEntry} />
            <TaskManageToolCard
              block={taskManageBlock}
              onOpenTask={() => {}}
              onApplyTaskStatusSuggestion={() => {}}
            />
            <ServedFileCard
              file={{
                url: "/api/files/tmp/example/report.md",
                label: "Weekly report",
                size: 4096,
              }}
            />
            <ServedFileCard
              file={{
                url: "/api/files/tmp/example/trace.bin",
                size: 2_400_000,
              }}
            />
            {worktreeProvisions.map((provision) => (
              <WorktreeProvisionCard
                key={provision.state}
                provision={provision}
                onRetry={() => {}}
                onOpenWorktree={() => {}}
              />
            ))}
            <WorkshopDraftHandoffToolCard
              block={workshopHandoffBlock}
              onCreateDraftSession={() => {}}
            />
          </>
        )}
      </div>
    </KnowledgeOpenTargetsProvider>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "tool-cards",
  title: "Cards/Tool cards",
  component: ToolCardsStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 640, surface: "results" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    surface: { control: "inline-radio", options: ["results", "questions"] },
  },
} satisfies Meta<typeof ToolCardsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Results: Story = {};
export const ResultsDark: Story = { globals: { theme: "dark" } };
export const Questions: Story = { args: { surface: "questions" } };
export const QuestionsDark: Story = {
  args: { surface: "questions" },
  globals: { theme: "dark" },
};
export const QuestionsPhone: Story = {
  args: { surface: "questions", frameWidth: 375 },
};
