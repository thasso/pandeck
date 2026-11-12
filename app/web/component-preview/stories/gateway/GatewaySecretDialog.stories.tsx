import type { Meta, StoryObj } from "@storybook/react-vite";
import { GatewaySecretDialog } from "../../../src/gateway/GatewaySecretDialog.tsx";
import {
  gatewayUiEnrollmentCode,
  gatewayUiMcpToken,
} from "../../fixtures/gatewayUi.ts";

const meta = {
  title: "App/Gateway/GatewaySecretDialog",
  component: GatewaySecretDialog,
  args: {
    title: "Enrollment code",
    label: "Enrollment code",
    secret: gatewayUiEnrollmentCode.code,
    onDone: () => {},
    children: (
      <>
        Valid for 15 minutes, once. Enter it in{" "}
        <code>gateway:relay enroll</code> on the new machine.
      </>
    ),
  },
} satisfies Meta<typeof GatewaySecretDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnrollmentCode: Story = {};
export const McpToken: Story = {
  args: {
    title: "MCP token for Work laptop",
    label: "MCP token",
    secret: gatewayUiMcpToken.token,
    children:
      "Give it to the MCP client on that machine. If it is lost, mint a new one; the old one then stops working.",
  },
};
