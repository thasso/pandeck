import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  chatViewMenuGroups,
  type ChatViewPrefs,
} from "../../../src/components/ChatHeaderMenu.tsx";
import { HeaderMenu } from "../../../src/components/common/HeaderMenu.tsx";
import { MobileLayoutContext } from "../../../src/components/shell/useMobileLayout.ts";
function HeaderMenuPreview({ mobile }: { mobile: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ChatViewPrefs>({
    showThinking: true,
    showTools: true,
    expandThinking: false,
    expandTools: false,
    wrapToolLines: false,
  });
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      host.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="Chat options"]')
        ?.click(),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div ref={host} className="min-h-96 bg-background">
      <header className="flex items-center justify-between p-4">
        <h2 className="text-lg">Chat regression review</h2>
        <MobileLayoutContext.Provider value={mobile}>
          <HeaderMenu
            label="Chat options"
            groups={chatViewMenuGroups({
              ...view,
              onChange: (patch) =>
                setView((current) => ({ ...current, ...patch })),
            })}
          />
        </MobileLayoutContext.Provider>
      </header>
    </div>
  );
}
const meta = {
  title: "App/Chat/Header menu",
  component: HeaderMenuPreview,
  args: { mobile: false },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HeaderMenuPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open = {} satisfies Story;
export const PhoneOpen = {
  args: { mobile: true },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
