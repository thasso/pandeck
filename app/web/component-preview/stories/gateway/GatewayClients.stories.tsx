import type { Meta, StoryObj } from "@storybook/react-vite";
import { GatewayClients } from "../../../src/gateway/GatewayClients.tsx";
import {
  gatewayUiClients,
  gatewayUiEnrollmentCode,
  gatewayUiMcpToken,
} from "../../fixtures/gatewayUi.ts";

/** Every action is inert in the preview. */
const meta = {
  title: "App/Gateway/GatewayClients",
  component: GatewayClients,
  args: {
    clients: { status: "ready", data: gatewayUiClients },
    createCode: () => Promise.resolve(gatewayUiEnrollmentCode),
    revoke: () => Promise.resolve(),
    mintMcpToken: () => Promise.resolve(gatewayUiMcpToken),
    revokeMcpToken: () => Promise.resolve(),
    reload: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GatewayClients>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { clients: { status: "loading" } } };
export const Empty: Story = {
  args: { clients: { status: "ready", data: [] } },
};
export const Listed: Story = {};
export const Error: Story = {
  args: { clients: { status: "error", error: "unavailable" } },
};
