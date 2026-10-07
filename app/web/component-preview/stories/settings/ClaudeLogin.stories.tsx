import type { Meta, StoryObj } from "@storybook/react-vite";
import { ClaudeLoginTerminalView } from "../../../src/components/ClaudeLoginTerminal.tsx";
import { settingsProfiles } from "../../fixtures/settings.ts";

const meta = {
  title: "App/Settings/Claude login",
  component: ClaudeLoginTerminalView,
  args: {
    profile: settingsProfiles[0]!,
    onClose: () => {},
    status: "connecting",
    output:
      "Starting Claude login…\nOpen the authorization page and paste the code here.\nhttps://claude.com/cai/oauth/authorize?preview=true",
    error: undefined,
    submit: () => true,
    cancel: () => true,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ClaudeLoginTerminalView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connecting: Story = {};
export const Starting: Story = { args: { output: "" } };
export const Connected: Story = {
  args: { status: "ready", output: "Authentication successful." },
};
export const Cancelled: Story = {
  args: { status: "cancelled", output: "Login cancelled." },
};
export const Error: Story = {
  args: {
    status: "error",
    output: "Authorization failed.",
    error: "The authorization code expired. Close and start login again.",
  },
};
