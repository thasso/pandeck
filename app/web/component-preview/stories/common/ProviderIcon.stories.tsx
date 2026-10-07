import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProviderIcon } from "../../../src/components/common/ProviderIcon.tsx";
function ProvidersStory() {
  return (
    <div className="flex items-center gap-6 p-8">
      {(["anthropic", "openai", "github", "generic"] as const).map(
        (provider) => (
          <div key={provider} className="flex items-center gap-2">
            <ProviderIcon provider={provider} size={24} title={provider} />
            <span className="text-sm capitalize">{provider}</span>
          </div>
        ),
      )}
    </div>
  );
}
const meta = {
  title: "Common/ProviderIcon",
  component: ProviderIcon,
  excludeStories: /.*Story$/,
} satisfies Meta<typeof ProviderIcon>;
export default meta;
export const ProviderBrands = {
  args: { provider: "anthropic" },
  render: () => <ProvidersStory />,
} satisfies StoryObj<typeof meta>;
