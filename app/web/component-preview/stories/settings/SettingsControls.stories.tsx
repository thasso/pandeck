import type { Meta, StoryObj } from "@storybook/react-vite";
import { CredentialProfileCard } from "../../../src/components/SettingsPage.tsx";
import {
  AgentModelFields,
  CredentialProfilesContext,
} from "../../../src/components/AgentModelFields.tsx";
import { RegistrySettingFields } from "../../../src/components/RegistrySettingFields.tsx";
import {
  settingsFixture,
  settingsModels,
  settingsProfiles,
} from "../../fixtures/settings.ts";

const noop = () => {};
const meta = {
  title: "Settings/Controls",
  component: CredentialProfileCard,
  args: {
    profile: settingsProfiles[0]!,
    providerLabel: "Claude",
    connectionLabel: "Reconnect",
    onToggle: noop,
    onConnect: noop,
    onRename: noop,
    onDelete: noop,
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CredentialProfileCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AccountReady: Story = {};
export const AccountDisconnected: Story = {
  args: {
    profile: { ...settingsProfiles[0]!, status: "disconnected" },
    connectionLabel: "Connect",
  },
};
export const AccountConnecting: Story = {
  args: {
    profile: { ...settingsProfiles[0]!, status: "connecting" },
    connectionLabel: "Continue login",
  },
};
export const AccountError: Story = {
  args: {
    profile: {
      ...settingsProfiles[0]!,
      status: "error",
      error: "Sign-in expired. Connect this profile again.",
    },
    connectionLabel: "Connect",
  },
};
export const AccountLongName: Story = {
  args: {
    profile: {
      ...settingsProfiles[0]!,
      name: "Research and development team account for model evaluation and code review",
    },
  },
};
export const AgentModel: Story = {
  render: () => (
    <CredentialProfilesContext.Provider value={settingsProfiles}>
      <AgentModelFields
        models={settingsModels}
        {...settingsFixture.commitAgent}
        onChange={noop}
      />
    </CredentialProfilesContext.Provider>
  ),
};
export const AgentWithoutModels: Story = {
  render: () => (
    <AgentModelFields
      models={[]}
      {...settingsFixture.commitAgent}
      onChange={noop}
    />
  ),
};
export const RegistryFields: Story = {
  render: () => (
    <RegistrySettingFields
      section="profile"
      settings={settingsFixture}
      onUpdate={noop}
      claimed={new Set()}
    />
  ),
};
