import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bot,
  CheckCircle2,
  GitCommitHorizontal,
  Inbox,
  Lightbulb,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import {
  AppCard,
  type AppCardTone,
} from "../../../src/components/common/AppCard.tsx";
import { Button } from "../../../src/components/ui/button.tsx";
import { Checkbox } from "../../../src/components/ui/checkbox.tsx";
import { Label } from "../../../src/components/ui/label.tsx";

export interface AppCardStoryProps {
  frameWidth: number;
}

const examples: Array<{
  tone: AppCardTone;
  icon: React.ReactNode;
  label: string;
  status?: string;
  subject: string;
  detail: string;
  actions?: boolean;
  footerStart?: string;
}> = [
  {
    tone: "neutral",
    icon: <Bot />,
    label: "Task update",
    subject: "Back off between provider retries",
    detail: "Moved to Doing and linked to this session.",
  },
  {
    tone: "info",
    icon: <Inbox />,
    label: "Inbox",
    subject: "An agent filed this Task; nobody has triaged it yet.",
    detail: "Plan it for today, or let it into the Backlog.",
    actions: true,
  },
  {
    tone: "warning",
    icon: <ShieldAlert />,
    label: "Approval needed",
    status: "github",
    subject: "Merge pull request #2116 into main",
    detail: "castlabs/prestoplay-web · squash merge",
    actions: true,
    footerStart: "Asks every time",
  },
  {
    tone: "success",
    icon: <CheckCircle2 />,
    label: "Committed",
    status: "a1b2c3d",
    subject: "Back off between provider retries",
    detail: "3 files · +48 −12",
  },
  {
    tone: "destructive",
    icon: <XCircle />,
    label: "Commit blocked",
    subject: "Two files contain what looks like a credential.",
    detail: "config/dev.env, scripts/deploy.sh",
    actions: true,
  },
];

/** The one card template, in every tone, with and without a footer. */
export function AppCardStory({ frameWidth }: AppCardStoryProps) {
  return (
    <div className="bg-background p-4" style={{ width: frameWidth }}>
      {examples.map((example) => (
        <AppCard
          key={example.label}
          tone={example.tone}
          icon={example.icon}
          label={example.label}
          status={example.status}
          footerStart={example.footerStart}
          actions={
            example.actions ? (
              <>
                <Button variant="ghost" size="xs">
                  Dismiss
                </Button>
                <Button size="xs">Continue</Button>
              </>
            ) : null
          }
        >
          <p className="font-medium">{example.subject}</p>
          <p className="text-muted-foreground">{example.detail}</p>
        </AppCard>
      ))}
      <AppCard
        tone="info"
        icon={<GitCommitHorizontal />}
        label="Footer options"
        status="settings that configure the footer's button"
        options={
          <Label>
            <Checkbox defaultChecked />
            <span className="text-xs">Delete branch</span>
          </Label>
        }
        actions={<Button size="xs">Merge</Button>}
      >
        <p className="text-muted-foreground">
          On a phone the options wrap above the buttons.
        </p>
      </AppCard>
      <AppCard
        icon={<GitCommitHorizontal />}
        label="Header only"
        status="no content, no footer"
      />
      <AppCard icon={<Lightbulb />} label="Flush content" flush>
        <ul className="divide-y">
          {["providerClient.ts", "retry.ts", "retry.test.ts"].map((file) => (
            <li key={file} className="px-3 py-1.5 font-mono">
              {file}
            </li>
          ))}
        </ul>
      </AppCard>
    </div>
  );
}

const meta = {
  excludeStories: /.*Story$/,
  id: "app-card",
  title: "App/Cards/App card",
  component: AppCardStory,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 640 },
  argTypes: {
    frameWidth: { control: { type: "range", min: 320, max: 960, step: 1 } },
  },
} satisfies Meta<typeof AppCardStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tones: Story = {};
export const TonesDark: Story = { globals: { theme: "dark" } };
export const TonesPhone: Story = { args: { frameWidth: 375 } };
