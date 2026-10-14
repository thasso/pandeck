import type { Meta, StoryObj } from "@storybook/react-vite";
import { SessionContextSections } from "../../../src/components/SessionContextSections.tsx";
import { noop } from "../../fixtures/chat.ts";

/**
 * The session inspector's Agent section: the definition a session was spawned
 * as, frozen at spawn (`docs/agent-definitions.md`), with its name linking to
 * the definition as the library holds it now.
 */
const meta = {
  title: "App/Chat/Inspector agent",
  component: SessionContextSections,
  args: {
    sessionId: "story-agent-session",
    onOpenAgent: noop,
    agent: {
      name: "test-reviewer",
      blob: "4f2a9c1e0b7d3a5c9e8f1a2b3c4d5e6f7a8b9c0d",
      model: "claude-sdk/opus (claude-opus-5-5)",
      effort: "high",
      denyTools: ["worktree_push", "bash"],
      skills: ["castlabs-ui"],
    },
  },
  render: (args) => (
    <div className="w-80 bg-background p-2">
      <SessionContextSections {...args} />
    </div>
  ),
} satisfies Meta<typeof SessionContextSections>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Frozen = {} satisfies Story;
export const Plain = {
  args: {
    agent: {
      name: "release-scribe",
      blob: "0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c",
      model: "openai-codex/gpt-6.1-sol",
      effort: "medium",
      denyTools: [],
      skills: [],
    },
  },
} satisfies Story;
export const Unreadable = {
  args: { agent: { name: "unreadable", unreadable: true } },
} satisfies Story;
