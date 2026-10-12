import type { Meta, StoryObj } from "@storybook/react-vite";
import type { SessionStatusCard } from "@assistant/shared";
import { SessionStatusPanel } from "../../../src/components/sessionStatus/SessionStatusPanel.tsx";

const HOUR = 60 * 60 * 1000;
const now = Date.now();

const card: SessionStatusCard = {
  sessionId: "2a141c92-48e8-43d3-aee3-5147330d9490",
  createdAt: now - 2 * HOUR,
  sessionUpdatedAt: now - 3 * HOUR,
  model: {
    provider: "openai-codex",
    modelId: "gpt-6-luna",
    thinkingLevel: "high",
  },
  markdown: `**Deploy SRS to test and complete cloud acceptance so Labs can integrate.** · [Task-761](pa://task/761)

🟡 **Waiting on you** · last activity Mon 12 Oct 20:19 (3 hours ago)

26 runs over 3 days (Thu 8, Fri 9, Mon 12 Oct) · $619.92

**What happened**

| When | What |
| --- | --- |
| Thu 8 Oct | Deployed team images to test and recorded acceptance in [#70](https://example.test/pull/70). |
| Mon 12 | Fixed the staging deploy login in [#80](https://example.test/pull/80); both deployments passed. |

**Your decisions**

- Thu 8 Oct: Skip the arm64 check for now; run the full teardown check.

**Pull requests**

| PR | What's in it |
| --- | --- |
| ✅ [#70](https://example.test/pull/70) | Enables team images in test and records cloud acceptance; arm64 stays open. |
| ✅ [#80](https://example.test/pull/80) | Trusts GitHub's ID-based OIDC subject so staging deploys log in again. |

**Keep in mind**

- You pasted AWS credentials twice; the key file was removed.

**Open**

- [ ] **You:** Move or revoke the test and staging admin tokens.
- [ ] **You:** Remove this session's worktree once you are done.`,
};

const loaded = { loaded: true, refreshing: false, error: null };

const meta = {
  title: "App/Shell/Session status panel",
  component: SessionStatusPanel,
  decorators: [
    (Story) => (
      <div className="flex h-screen w-96 flex-col surface-sidebar border-l border-border">
        <Story />
      </div>
    ),
  ],
  args: {
    sessionId: card.sessionId,
    sessionUpdatedAt: card.sessionUpdatedAt,
    initialState: { ...loaded, card },
  },
} satisfies Meta<typeof SessionStatusPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Card: Story = {};

export const CardDark: Story = { globals: { theme: "dark" } };

/** The session went on after the card was written. */
export const BehindTheSession: Story = {
  args: { sessionUpdatedAt: now - HOUR },
};

/** A refresh keeps the old card on screen until the new one lands. */
export const Refreshing: Story = {
  args: { initialState: { ...loaded, card, refreshing: true } },
};

export const RefreshFailed: Story = {
  args: {
    initialState: {
      ...loaded,
      card,
      error: "Writing the session status timed out.",
    },
  },
};

export const NoCardYet: Story = {
  args: { initialState: { ...loaded, card: null } },
};

export const WritingFirstCard: Story = {
  args: { initialState: { ...loaded, card: null, refreshing: true } },
};

export const NoSession: Story = { args: { sessionId: undefined } };
