import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommitCard } from "../../../src/components/CommitCard.tsx";
import { PullRequestCard } from "../../../src/components/PullRequestCard.tsx";
import { PushCard } from "../../../src/components/PushCard.tsx";
import { commits, pullRequests, pushes } from "../../fixtures/cards.ts";

type GitSurface = "commit" | "push" | "pull-request";

export interface GitCardsStoryProps {
  frameWidth: number;
  surface: GitSurface;
}

/** Every state of one git result card, in transcript order. */
export function GitCardsStory({ frameWidth, surface }: GitCardsStoryProps) {
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      {surface === "commit"
        ? commits.map((commit, index) => (
            <CommitCard key={index} commit={commit} onAccept={() => {}} />
          ))
        : surface === "push"
          ? pushes.map((push, index) => <PushCard key={index} push={push} />)
          : pullRequests.map((card) => (
              <PullRequestCard
                key={card.id}
                pullRequest={card}
                sessionWorktreeId="wt-742"
                onChooseTask={() => {}}
                onAction={() => {}}
              />
            ))}
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "git-cards",
  title: "Cards/Git results",
  component: GitCardsStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 720, surface: "commit" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    surface: {
      control: "inline-radio",
      options: ["commit", "push", "pull-request"],
    },
  },
} satisfies Meta<typeof GitCardsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Commits: Story = {};
export const CommitsDark: Story = { globals: { theme: "dark" } };
export const Pushes: Story = { args: { surface: "push" } };
export const PushesDark: Story = {
  args: { surface: "push" },
  globals: { theme: "dark" },
};
export const PullRequests: Story = { args: { surface: "pull-request" } };
export const PullRequestsDark: Story = {
  args: { surface: "pull-request" },
  globals: { theme: "dark" },
};
export const PullRequestsPhone: Story = {
  args: { surface: "pull-request", frameWidth: 375 },
};
