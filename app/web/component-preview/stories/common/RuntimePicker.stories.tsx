import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ModelQuickRow,
  ProviderAccountRow,
} from "../../../src/components/common/RuntimePicker.tsx";
import type { ModelOption } from "@assistant/shared";
const accounts = [
  { id: "claude-work", name: "Work account", provider: "claude" },
  { id: "codex-personal", name: "Personal", provider: "openai-codex" },
] as const;
const models: ModelOption[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
    contextWindow: 200000,
  },
  {
    provider: "openai-codex",
    id: "gpt-5-codex",
    name: "GPT-5 Codex",
    reasoning: true,
    contextWindow: 128000,
  },
];
function RuntimePickerStory() {
  return (
    <div className="space-y-6 p-6">
      <ProviderAccountRow
        accounts={accounts}
        selectedId="claude-work"
        usageIndicators={null}
        onSelect={() => {}}
      />
      <ModelQuickRow models={models} selected={models[0]} onSelect={() => {}} />
    </div>
  );
}
const meta = {
  title: "Common/RuntimePicker",
  component: RuntimePickerStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof RuntimePickerStory>;
export default meta;
export const QuickStartChoices = {} satisfies StoryObj<typeof meta>;
