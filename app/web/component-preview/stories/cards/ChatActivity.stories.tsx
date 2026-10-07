import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CircleCheck,
  CircleX,
  Info,
  MessageSquare,
} from "lucide-react";
import { ChatActivityRow } from "../../../src/components/ChatActivityRow.tsx";
import { Markdown } from "../../../src/components/Markdown.tsx";

export interface ChatActivityStoryProps {
  frameWidth: number;
  expanded: boolean;
}

const review = `The collapse behavior looks good. I found one issue on mobile:

- Keep the peer link separate from the expand button.
- Long session names must not push the status offscreen.

The keyboard interaction and default collapsed state both pass.`;

/** Candidate rows only. The live transcript is unchanged until design approval. */
export function ChatActivityStory({
  frameWidth,
  expanded,
}: ChatActivityStoryProps) {
  const [openedSource, setOpenedSource] = useState("");
  return (
    <main
      style={{ width: frameWidth, maxWidth: "100%" }}
      className="min-h-screen bg-background px-5 py-6 text-sm text-foreground sm:px-8"
    >
      <div className="mb-7 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3.5 py-2">
          Make peer messages collapsible. Keep the focus on our conversation.
        </div>
      </div>
      <p className="mb-4">
        I’ll ask Sol to review the interaction while I check the mobile layout.
      </p>
      <div className="mb-4">
        <ChatActivityRow
          icon={ArrowUpRight}
          prefix="To"
          title="Sol"
          href="#sol"
          onOpenSource={() => setOpenedSource("Sol")}
          preview="Review the collapse behavior and keyboard interaction."
          status={{ label: "Delivered", icon: Check }}
        >
          <Markdown text="Review the collapse behavior and keyboard interaction. Check that peer messages start collapsed and that opening a session does not also expand the message." />
          <p className="mt-2 text-sm text-muted-foreground">
            Response requested
          </p>
        </ChatActivityRow>
        <ChatActivityRow
          icon={Activity}
          title="Tests"
          preview="Component tests passed"
          status={{ label: "Passed", icon: CircleCheck }}
        >
          <p>All 12 component tests passed.</p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-card p-3 text-sm">
            pnpm --filter @assistant/web test
          </pre>
        </ChatActivityRow>
        <ChatActivityRow
          icon={ArrowDownLeft}
          prefix="From"
          title="Sol"
          href="#sol"
          onOpenSource={() => setOpenedSource("Sol")}
          preview="The collapse behavior looks good. I found one issue on mobile."
          status={{ label: "Replied", icon: MessageSquare }}
          defaultExpanded={expanded}
        >
          <Markdown text={review} />
        </ChatActivityRow>
      </div>
      <p className="mb-8">
        The rows now stay on one line. You can read the full exchange without
        leaving this chat, or open Sol’s session from the name.
      </p>
      <section
        className="border-t border-border pt-5"
        aria-label="Additional activity states"
      >
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">
          Other states
        </h2>
        <ChatActivityRow
          icon={ArrowUpRight}
          prefix="To"
          title="Opus"
          href="#opus"
          onOpenSource={() => setOpenedSource("Opus")}
          preview="Check the final desktop and mobile screenshots."
          status={{ label: "Failed", icon: CircleX, attention: true }}
        >
          <Markdown text="Check the final desktop and mobile screenshots." />
          <p className="mt-2 text-sm text-destructive">
            Not delivered. The recipient session is no longer available.
          </p>
        </ChatActivityRow>
        <ChatActivityRow
          icon={ArrowDownLeft}
          prefix="From"
          title="Sol reviewing keyboard accessibility"
          href="#sol-accessibility"
          onOpenSource={() =>
            setOpenedSource("Sol reviewing keyboard accessibility")
          }
          preview="Keyboard navigation passes. No focus traps found."
          status={{ label: "Replied", icon: MessageSquare }}
        >
          <p className="mb-2 text-sm text-muted-foreground">
            From Sol reviewing keyboard accessibility
          </p>
          <Markdown text="Keyboard navigation passes. No focus traps found. Tab reaches the session link and the disclosure separately. Enter and Space toggle the message." />
        </ChatActivityRow>
        <ChatActivityRow
          icon={Info}
          title="Context"
          preview="Earlier messages were compacted"
        >
          <p>
            Earlier messages were compacted. The agent continues with a summary
            of the conversation.
          </p>
        </ChatActivityRow>
        <p className="mt-4 text-xs text-muted-foreground">
          Preview only. Click a row’s preview or chevron to expand it.
        </p>
        {openedSource ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            This link would open {openedSource}’s session.
          </p>
        ) : null}
      </section>
    </main>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "chat-activity",
  title: "Cards/Side activity",
  component: ChatActivityStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ChatActivityStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop = {
  args: { frameWidth: 760, expanded: false },
} satisfies Story;
export const Expanded = {
  args: { frameWidth: 760, expanded: true },
} satisfies Story;
export const Phone = {
  args: { frameWidth: 390, expanded: false },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
export const PhoneExpanded = {
  args: { frameWidth: 390, expanded: true },
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
