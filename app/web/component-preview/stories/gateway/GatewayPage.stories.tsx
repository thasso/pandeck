import type { Meta, StoryObj } from "@storybook/react-vite";
import type { GatewayAccountsProps } from "../../../src/gateway/GatewayAccounts.tsx";
import type { GatewayAtlassianProps } from "../../../src/gateway/GatewayAtlassian.tsx";
import type { GatewayClientsProps } from "../../../src/gateway/GatewayClients.tsx";
import { GatewayPage } from "../../../src/gateway/GatewayPage.tsx";
import type { GatewayLogin } from "../../../src/gateway/useGatewayLogin.ts";
import {
  gatewayUiAccounts,
  gatewayUiAtlassianConnected,
  gatewayUiClients,
  gatewayUiEnrollmentCode,
  gatewayUiMcpToken,
  gatewayUiMe,
} from "../../fixtures/gatewayUi.ts";

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
const atlassian = (
  status: GatewayAtlassianProps["status"],
): GatewayAtlassianProps => ({
  status,
  save: () => Promise.resolve(gatewayUiAtlassianConnected),
  clear: () => Promise.resolve(),
});
const clients = (
  state: GatewayClientsProps["clients"],
): GatewayClientsProps => ({
  clients: state,
  createCode: () => Promise.resolve(gatewayUiEnrollmentCode),
  revoke: () => Promise.resolve(),
  mintMcpToken: () => Promise.resolve(gatewayUiMcpToken),
  revokeMcpToken: () => Promise.resolve(),
  reload: () => {},
});
/** The Jira and Clients sections, inert, beside the accounts stories. */
const settings = {
  atlassian: atlassian({ status: "ready", data: { connected: false } }),
  clients: clients({ status: "ready", data: [] }),
};
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
  args: { state: { kind: "signedIn", me: gatewayUiMe }, ...settings },
};
export const SigningOut: Story = {
  args: { state: { kind: "signedIn", me: gatewayUiMe }, signingOut: true },
};
export const Unavailable: Story = { args: { state: { kind: "unavailable" } } };
export const AccountsLoading: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "loading" }),
    ...settings,
  },
};
export const AccountsEmpty: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "ready", data: [] }),
    ...settings,
  },
};
export const AccountsListed: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "ready", data: gatewayUiAccounts }),
    ...settings,
  },
};
export const AccountsError: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "error", error: "unavailable" }),
    ...settings,
  },
};
export const SignedInAllSections: Story = {
  args: {
    state: signedIn,
    accounts: accounts({ status: "ready", data: gatewayUiAccounts }),
    atlassian: atlassian({
      status: "ready",
      data: gatewayUiAtlassianConnected,
    }),
    clients: clients({ status: "ready", data: gatewayUiClients }),
  },
};
