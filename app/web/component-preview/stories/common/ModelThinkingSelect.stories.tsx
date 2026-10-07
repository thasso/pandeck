import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ModelSelect,
  ThinkingSelect,
} from "../../../src/components/common/ModelThinkingSelect.tsx";
import type { ModelOption } from "@assistant/shared";
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
function ModelThinkingStory() {
  return (
    <div className="flex flex-wrap items-center gap-3 p-8">
      <ModelSelect models={models} value={models[0]} onChange={() => {}} />
      <ThinkingSelect model={models[0]} value="medium" onChange={() => {}} />
    </div>
  );
}
const meta = {
  title: "Common/ModelThinkingSelect",
  component: ModelThinkingStory,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof ModelThinkingStory>;
export default meta;
export const ModelAndThinking = {} satisfies StoryObj<typeof meta>;
