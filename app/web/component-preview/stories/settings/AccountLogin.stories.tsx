import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AccountLoginDialogView } from "../../../src/components/AccountLoginDialogView.tsx";

const CLAUDE_OUTPUT =
  "Starting the official Claude login…\nOpen the authorization page and paste the code here.\nhttps://claude.com/cai/oauth/authorize?preview=true";
const DEVICE = {
  verificationUri: "https://auth.openai.com/codex/device",
  userCode: "PREV-1234",
};

const meta = {
  title: "App/Settings/Account login",
  component: AccountLoginDialogView,
  args: {
    provider: "claude",
    accountName: "Claude personal",
    status: "connecting",
    output: CLAUDE_OUTPUT,
    // Pandeck's host answers at once; the gateway page's with a promise.
    submit: (() => true) as (code: string) => boolean | Promise<boolean>,
    cancel: () => {},
    onClose: () => {},
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AccountLoginDialogView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ClaudeStarting: Story = { args: { output: "" } };
export const ClaudeConnecting: Story = {};
export const ClaudeConnected: Story = {
  args: { status: "ready", output: "Authentication successful." },
};
export const ClaudeCancelled: Story = {
  args: {
    status: "cancelled",
    output: `${CLAUDE_OUTPUT}\nClaude login cancelled.`,
  },
};
export const ClaudeError: Story = {
  args: {
    status: "error",
    output: "Authorization failed.",
    error: "The authorization code expired. Close and start login again.",
  },
};

/** Pastes a code and submits it; the dialog is portaled to the body. */
async function pasteCode(): Promise<void> {
  const body = within(document.body);
  await userEvent.type(
    body.getByLabelText("Paste the authorization code"),
    "preview-code",
  );
  await userEvent.click(body.getByRole("button", { name: "Submit" }));
}

/** The gateway page's host: the code is sent while Submit is busy. */
export const ClaudeSubmitting: Story = {
  args: { submit: () => new Promise<boolean>(() => {}) },
  play: pasteCode,
};
/** The gateway did not take the code: it stays, with an inline error. */
export const ClaudeSubmitFailed: Story = {
  args: { submit: () => Promise.resolve(false) },
  play: async () => {
    await pasteCode();
    await expect(
      await within(document.body).findByText(
        "The code was not sent. Try again.",
      ),
    ).toBeInTheDocument();
  },
};

const openAi = {
  provider: "openai-codex",
  accountName: "OpenAI work",
  output: "",
} as const;
export const OpenAiStarting: Story = { args: { ...openAi } };
export const OpenAiDeviceShown: Story = {
  args: { ...openAi, device: DEVICE },
};
export const OpenAiCancelNotConfirmed: Story = {
  args: { ...openAi, device: DEVICE, cancelUnconfirmed: true },
};
export const OpenAiCancelled: Story = {
  args: { ...openAi, status: "cancelled", device: DEVICE },
};
export const OpenAiError: Story = {
  args: {
    ...openAi,
    status: "error",
    error:
      "OpenAI device-code login timed out. The active login will finish before another can start.",
  },
};
