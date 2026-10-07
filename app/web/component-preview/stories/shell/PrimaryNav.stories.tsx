import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrimaryNav } from "../../../src/components/shell/PrimaryNav.tsx";
import { PRIMARY_NAV_SLOTS } from "../../../src/components/primaryNavSections.tsx";
import {
  DEFAULT_NAV_SLOTS,
  type NavSlot,
} from "../../../src/hooks/useSidebarSection.ts";

const sections = DEFAULT_NAV_SLOTS.map((id) => ({
  id,
  ...PRIMARY_NAV_SLOTS[id],
}));

/**
 * The sidebar's primary navigation in the column it measures: slots that do not
 * fit fold into the More menu on a wide layout, or into the bottom card a phone
 * drags up.
 */
function PrimaryNavStory({
  width,
  mobile,
}: {
  width: number;
  mobile: boolean;
}) {
  const [active, setActive] = useState<NavSlot>("sessions");
  return (
    <div
      className="relative flex h-screen flex-col justify-end bg-card"
      style={{ width }}
    >
      <PrimaryNav
        sections={sections}
        activeId={active}
        onSelect={setActive}
        mobile={mobile}
        onCustomizeOrder={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "App/Shell/Primary navigation",
  component: PrimaryNavStory,
  parameters: { layout: "fullscreen" },
  args: { width: 256, mobile: false },
  argTypes: {
    width: { control: { type: "range", min: 160, max: 640, step: 1 } },
  },
} satisfies Meta<typeof PrimaryNavStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default rail: the active pill, a few slots and the More menu. */
export const WithOverflow: Story = {};

export const WithOverflowDark: Story = { globals: { theme: "dark" } };

/** Wide enough for every slot: no More control at all. */
export const Wide: Story = { args: { width: 640 } };

export const Phone: Story = {
  args: { width: 390, mobile: true },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const PhoneDark: Story = {
  args: { width: 390, mobile: true },
  globals: { theme: "dark", viewport: { value: "paPhone", isRotated: false } },
};
