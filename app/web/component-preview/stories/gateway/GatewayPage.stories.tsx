import type { Meta, StoryObj } from "@storybook/react-vite";
import { GatewayPage } from "../../../src/gateway/GatewayPage.tsx";
import { gatewayUiMe } from "../../fixtures/gatewayUi.ts";

const meta = {
  title: "App/Gateway/GatewayPage",
  component: GatewayPage,
  args: {
    state: { kind: "signedOut" },
    onSignOut: () => {},
    signingOut: false,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GatewayPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { state: { kind: "loading" } } };
export const SignedOut: Story = {};
export const Denied: Story = {
  args: { state: { kind: "signedOut", signin: "denied" } },
};
export const Expired: Story = {
  args: { state: { kind: "signedOut", signin: "expired" } },
};
export const Failed: Story = {
  args: { state: { kind: "signedOut", signin: "failed" } },
};
export const Busy: Story = {
  args: { state: { kind: "signedOut", signin: "busy" } },
};
export const SignedIn: Story = {
  args: { state: { kind: "signedIn", me: gatewayUiMe } },
};
export const SigningOut: Story = {
  args: { state: { kind: "signedIn", me: gatewayUiMe }, signingOut: true },
};
export const Unavailable: Story = { args: { state: { kind: "unavailable" } } };
