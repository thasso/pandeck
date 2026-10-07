import type { Meta, StoryObj } from "@storybook/react-vite";
import { UsageCycleMeters } from "../../../src/components/common/UsageCycleMeters.tsx";
const meta = {
  title: "Common/UsageCycleMeters",
  component: UsageCycleMeters,
} satisfies Meta<typeof UsageCycleMeters>;
export default meta;
export const Loading = {
  args: { indicator: undefined, now: Date.now() },
} satisfies StoryObj<typeof meta>;
export const NoPlanLimits = {
  args: {
    indicator: {
      profileId: "claude-work",
      provider: "claude",
      limitsAvailable: false,
      refreshing: false,
      fetchedAt: Date.now(),
      short: null,
      long: null,
    },
    now: Date.now(),
  },
} satisfies StoryObj<typeof meta>;
