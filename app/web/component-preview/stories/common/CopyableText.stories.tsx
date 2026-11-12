import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { CopyableText } from "../../../src/components/common/CopyableText.tsx";

/** Each story says whether the browser offers a clipboard (plain http not). */
const clipboard =
  (offered: boolean) =>
  (Story: () => ReactElement): ReactElement => {
    Object.defineProperty(navigator, "clipboard", {
      value: offered ? { writeText: () => Promise.resolve() } : undefined,
      configurable: true,
    });
    return (
      <div className="max-w-md p-6">
        <Story />
      </div>
    );
  };

const meta = {
  title: "Common/CopyableText",
  component: CopyableText,
  args: {
    value: "pgmcp_FAKE-token-for-the-preview-only",
    label: "MCP token",
    copyLabel: "Copy MCP token",
    copiedLabel: "MCP token copied",
  },
} satisfies Meta<typeof CopyableText>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { decorators: [clipboard(true)] };
export const Copied: Story = {
  decorators: [clipboard(true)],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Copy MCP token" }),
    );
  },
};
export const NoClipboard: Story = { decorators: [clipboard(false)] };
