import type { Meta, StoryObj } from "@storybook/react-vite";
import { GatewayAtlassian } from "../../../src/gateway/GatewayAtlassian.tsx";
import {
  gatewayUiAtlassianConnected,
  gatewayUiAtlassianLocked,
  gatewayUiAtlassianNotSet,
} from "../../fixtures/gatewayUi.ts";

/** Every action is inert in the preview. */
const meta = {
  title: "App/Gateway/GatewayAtlassian",
  component: GatewayAtlassian,
  args: {
    status: { status: "ready", data: gatewayUiAtlassianNotSet },
    save: () => Promise.resolve(gatewayUiAtlassianConnected),
    clear: () => Promise.resolve(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GatewayAtlassian>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { status: { status: "loading" } } };
export const NotSet: Story = {};
export const Connected: Story = {
  args: { status: { status: "ready", data: gatewayUiAtlassianConnected } },
};
export const VaultLocked: Story = {
  args: { status: { status: "ready", data: gatewayUiAtlassianLocked } },
};
export const Error: Story = {
  args: { status: { status: "error", error: "unavailable" } },
};
