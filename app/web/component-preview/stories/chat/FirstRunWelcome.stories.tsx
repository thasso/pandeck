import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  CredentialProfileProvider,
  CredentialProfileSummary,
} from "@assistant/shared";
import { FirstRunWelcome } from "../../../src/components/FirstRunWelcome.tsx";
import { firstAccountSteps } from "../../../src/lib/firstRun.ts";
import { firstRunEarlierAccounts } from "../../fixtures/chat.ts";

function WelcomePreview({
  frameWidth,
  accounts,
  assistantName,
  error,
}: {
  frameWidth: number;
  accounts: CredentialProfileSummary[];
  assistantName: string;
  error?: string;
}) {
  const [busyKind, setBusyKind] = useState<CredentialProfileProvider | null>(
    null,
  );
  return (
    <div
      style={{ width: frameWidth, maxWidth: "100%" }}
      className="bg-background"
    >
      <FirstRunWelcome
        assistantName={assistantName}
        steps={firstAccountSteps(accounts, {})}
        busyKind={busyKind}
        error={error ?? null}
        onStep={(step) =>
          setBusyKind((current) => (current === step.kind ? null : step.kind))
        }
      />
    </div>
  );
}

const meta = {
  title: "App/Chat/First-run welcome",
  component: WelcomePreview,
  args: { frameWidth: 800, accounts: [], assistantName: "Larry" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WelcomePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
/** A fresh install: nothing to continue. */
export const FreshInstall = {} satisfies Story;
/** Earlier accounts are continued rather than created again. */
export const EarlierAccounts = {
  args: { accounts: firstRunEarlierAccounts },
} satisfies Story;
/** A custom assistant name is kept. */
export const CustomName = { args: { assistantName: "Ada" } } satisfies Story;
export const Failure = {
  args: { error: "The account could not be created. Try again." },
} satisfies Story;
export const Phone = {
  args: { frameWidth: 390 },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
