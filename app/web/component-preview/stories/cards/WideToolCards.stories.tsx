import type { Meta, StoryObj } from "@storybook/react-vite";
import { GoogleWorkspaceToolCard } from "../../../src/components/GoogleWorkspaceToolCard.tsx";
import { JiraToolCard } from "../../../src/components/JiraToolCard.tsx";
import {
  calendarBlock,
  driveBlock,
  gmailSearchBlock,
  gmailThreadBlock,
  jiraProjectsBlock,
  jiraSearchBlock,
  jiraUsersBlock,
} from "../../fixtures/cards.ts";

type WideSurface = "jira" | "google";

export interface WideToolCardsStoryProps {
  /** The chat column the cards break out of. */
  frameWidth: number;
  surface: WideSurface;
}

/** The table cards wider than the chat column, inside a chat-width column. */
export function WideToolCardsStory({
  frameWidth,
  surface,
}: WideToolCardsStoryProps) {
  return (
    <div
      className="flex justify-center bg-background p-4"
      style={{ "--shell-main-width": "1200px" } as React.CSSProperties}
    >
      <div style={{ width: frameWidth }}>
        {surface === "jira" ? (
          <>
            <JiraToolCard block={jiraSearchBlock} />
            <JiraToolCard block={jiraProjectsBlock} />
            <JiraToolCard block={jiraUsersBlock} />
          </>
        ) : (
          <>
            <GoogleWorkspaceToolCard block={calendarBlock} />
            <GoogleWorkspaceToolCard block={gmailSearchBlock} />
            <GoogleWorkspaceToolCard block={gmailThreadBlock} />
            <GoogleWorkspaceToolCard block={driveBlock} />
          </>
        )}
      </div>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "wide-tool-cards",
  title: "Cards/Wide tool cards",
  component: WideToolCardsStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 720, surface: "jira" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 360, max: 960, step: 1 } },
    surface: { control: "inline-radio", options: ["jira", "google"] },
  },
} satisfies Meta<typeof WideToolCardsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Jira: Story = {};
export const JiraDark: Story = { globals: { theme: "dark" } };
export const Google: Story = { args: { surface: "google" } };
export const GoogleDark: Story = {
  args: { surface: "google" },
  globals: { theme: "dark" },
};
