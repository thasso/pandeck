import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GatewayAccountsProps } from "../../../src/gateway/GatewayAccounts.tsx";
import { GatewayPage } from "../../../src/gateway/GatewayPage.tsx";
import type { GatewayLogin } from "../../../src/gateway/useGatewayLogin.ts";
import { gatewayUiAccounts, gatewayUiMe } from "../../fixtures/gatewayUi.ts";

/** No login runs: every action is inert in the preview. */
const idleLogin: GatewayLogin = {
  dialog: null,
  open: () => {},
  submit: () => Promise.resolve(false),
  cancel: () => {},
  close: () => {},
};
const accounts = (
  state: GatewayAccountsProps["accounts"],
): GatewayAccountsProps => ({
  accounts: state,
  login: idleLogin,
  remove: () => Promise.resolve(),
});
const signedIn = { kind: "signedIn", me: gatewayUiMe } as const;

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
export const AccountsLoading: Story = {
  args: { state: signedIn, accounts: accounts({ status: "loading" }) },
};
export const AccountsEmpty: Story = {
  args: { state: signedIn, accounts: accounts({ status: "ready", data: [] }) },
};
export const AccountsListed: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "ready", data: gatewayUiAccounts }),
  },
};
export const AccountsError: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "error", error: "unavailable" }),
  },
};
