import type { Meta, StoryObj } from "@storybook/react-vite";
import { Archive, GitMerge, MessageSquarePlus, Trash2, X } from "lucide-react";
import {
  PageHeader,
  sessionHeaderIcon,
} from "../../../src/components/PageHeader.tsx";
import { IconButton } from "../../../src/components/common/IconButton.tsx";
import { Inspector } from "../../../src/components/shell/Inspector.tsx";
import { RoutePrimaryActionProvider } from "../../../src/components/shell/RoutePrimaryAction.tsx";

const noop = () => {};

interface PageHeaderStoryProps {
  persona: "assistant" | "workshop" | "developer";
  density: "default" | "compact";
  withBack: boolean;
  withActions: boolean;
}

/**
 * The production `PageHeader` with the object's primary action in its slot and
 * the secondary actions an (unseen) Inspector publishes into its `…` menu.
 */
function PageHeaderStory({
  persona,
  density,
  withBack,
  withActions,
}: PageHeaderStoryProps) {
  const { icon, iconTone } = sessionHeaderIcon("session", {
    agentType: persona,
  });
  return (
    <RoutePrimaryActionProvider
      action={
        withActions
          ? {
              label: "Start a new session",
              icon: <MessageSquarePlus />,
              onRun: noop,
            }
          : null
      }
    >
      <div className="bg-background">
        <PageHeader
          icon={icon}
          iconTone={iconTone}
          onIconClick={noop}
          iconLabel="Copy session id"
          density={density}
          back={withBack ? { label: "Sessions", onClick: noop } : undefined}
          title="Refine attention list rows"
          subtitle="Pandeck · pa-attention-rows · updated 2 minutes ago"
          close={
            <IconButton label="Close" onClick={noop}>
              <X />
            </IconButton>
          }
        />
      </div>
      {withActions ? (
        <div className="hidden">
          <Inspector
            relations={[]}
            actions={[
              {
                key: "merge",
                icon: <GitMerge />,
                label: "Merge into main",
                onRun: noop,
              },
              {
                key: "archive",
                icon: <Archive />,
                label: "Archive",
                hint: "E",
                onRun: noop,
              },
              {
                key: "delete",
                icon: <Trash2 />,
                label: "Delete",
                disabled: true,
                disabledReason: "Still running",
                onRun: noop,
              },
            ]}
          />
        </div>
      ) : null}
    </RoutePrimaryActionProvider>
  );
}

const meta = {
  title: "App/Shell/Page header",
  component: PageHeaderStory,
  parameters: { layout: "fullscreen" },
  args: {
    persona: "assistant",
    density: "default",
    withBack: false,
    withActions: true,
  },
  argTypes: {
    persona: {
      control: "inline-radio",
      options: ["assistant", "workshop", "developer"],
    },
    density: { control: "inline-radio", options: ["default", "compact"] },
  },
} satisfies Meta<typeof PageHeaderStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithActions: Story = {};

export const WithActionsDark: Story = { globals: { theme: "dark" } };

export const Workshop: Story = { args: { persona: "workshop" } };

export const DeveloperCompact: Story = {
  args: { persona: "developer", density: "compact" },
};

export const PhoneWithBack: Story = {
  args: { withBack: true, withActions: false },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const PhoneWithBackDark: Story = {
  args: { withBack: true, withActions: false },
  globals: { theme: "dark", viewport: { value: "paPhone", isRotated: false } },
};
