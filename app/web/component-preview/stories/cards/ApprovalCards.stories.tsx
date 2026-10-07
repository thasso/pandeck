import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalCard } from "../../../src/components/ApprovalCard.tsx";
import { approvalBodies, approvalLifecycle } from "../../fixtures/cards.ts";

export interface ApprovalCardsStoryProps {
  frameWidth: number;
  set: "lifecycle" | "bodies";
}

/** Approval cards as the transcript shows them, one set at a time. */
export function ApprovalCardsStory({
  frameWidth,
  set,
}: ApprovalCardsStoryProps) {
  const cards = set === "lifecycle" ? approvalLifecycle : approvalBodies;
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      {cards.map((card) => (
        <ApprovalCard key={card.id} approval={card} onResolve={() => {}} />
      ))}
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "approval-cards",
  title: "Cards/Approvals",
  component: ApprovalCardsStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 720, set: "lifecycle" },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
    set: { control: "inline-radio", options: ["lifecycle", "bodies"] },
  },
} satisfies Meta<typeof ApprovalCardsStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Lifecycle: Story = {};
export const LifecycleDark: Story = { globals: { theme: "dark" } };
export const Bodies: Story = { args: { set: "bodies" } };
export const BodiesDark: Story = {
  args: { set: "bodies" },
  globals: { theme: "dark" },
};
export const BodiesPhone: Story = { args: { set: "bodies", frameWidth: 375 } };
