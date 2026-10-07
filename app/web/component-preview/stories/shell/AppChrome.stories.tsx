import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Topbar } from "../../../src/components/Topbar.tsx";
import { AppStatus } from "../../../src/components/AppStatus.tsx";
import { ToastViewport } from "../../../src/components/ToastViewport.tsx";
import { dismissToast, showToast } from "../../../src/lib/toast.ts";
import type { AppReloadState } from "../../../src/lib/appStatus.ts";
import { shellPrefs } from "../../fixtures/shell.ts";

interface AppChromeStoryProps {
  /** What the app-wide status slot says. */
  status: "live" | "restart-queued" | "restarting" | "reconnecting";
  /** Raise a toast of this tone on mount. */
  toast: "none" | "default" | "success" | "error";
}

const RELOADING: Record<AppChromeStoryProps["status"], AppReloadState | null> =
  {
    live: null,
    "restart-queued": { phase: "pending", runningCount: 2 },
    restarting: { phase: "reloading" },
    reconnecting: null,
  };

const TOAST_TEXT = {
  default: "Copied the session link",
  success: "Archived “Refine attention rows”",
  error: "Could not archive “Refine attention rows”: the server refused",
} as const;

/**
 * The desktop top bar with the app status slot centred in it, the phone's
 * floating placement of the same slot, and the toast viewport.
 */
function AppChromeStory({ status, toast }: AppChromeStoryProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => {
    if (toast === "none") return;
    // Held open (no dwell) so the toast stays on screen to be looked at.
    const id = showToast(TOAST_TEXT[toast], {
      tone: toast,
      durationMs: 0,
      ...(toast === "success"
        ? { action: { label: "Undo", onClick: () => {} } }
        : {}),
    });
    return () => dismissToast(id);
  }, [toast]);
  const connected = status !== "reconnecting";
  return (
    <div className="h-screen bg-background">
      <Topbar
        prefs={shellPrefs}
        updatePrefs={() => {}}
        sidebarOpen={sidebarOpen}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onToggleInspector={() => setInspectorOpen((open) => !open)}
        connected={connected}
        reloading={RELOADING[status]}
        hydrationSource="live"
      />
      <AppStatus
        connected={connected}
        reloading={RELOADING[status]}
        hydrationSource="live"
        placement="floating"
      />
      <ToastViewport />
    </div>
  );
}

const meta = {
  title: "Shell/App chrome",
  component: AppChromeStory,
  parameters: { layout: "fullscreen" },
  args: { status: "restart-queued", toast: "success" },
  argTypes: {
    status: {
      control: "inline-radio",
      options: ["live", "restart-queued", "restarting", "reconnecting"],
    },
    toast: {
      control: "inline-radio",
      options: ["none", "default", "success", "error"],
    },
  },
} satisfies Meta<typeof AppChromeStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RestartQueuedWithToast: Story = {};

export const RestartQueuedWithToastDark: Story = {
  globals: { theme: "dark" },
};

export const Restarting: Story = {
  args: { status: "restarting", toast: "none" },
};

/** Appears after the reconnect grace period. */
export const Reconnecting: Story = {
  args: { status: "reconnecting", toast: "error" },
};

export const PhoneStatus: Story = {
  args: { status: "restarting", toast: "default" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
};

export const PhoneStatusDark: Story = {
  args: { status: "restarting", toast: "default" },
  globals: { theme: "dark", viewport: { value: "paPhone", isRotated: false } },
};
