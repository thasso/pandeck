import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect } from "react";
import { expect, userEvent, within } from "storybook/test";
import type { BackgroundWorkItemSummary } from "@assistant/shared";
import { UsagePage } from "../../../src/components/UsagePage.tsx";
import { BackgroundTasksPage } from "../../../src/components/BackgroundTasksPage.tsx";
import {
  backgroundSessions,
  backgroundWorks,
  claudeUsage,
  longBackgroundWork,
  openAiUsage,
  usageProfiles,
} from "../../fixtures/settingsUsage.ts";

const readOnlyResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

type UsageScenario = "populated" | "empty" | "loading" | "error" | "credits";

function UsagePreview({ scenario }: { scenario: UsageScenario }) {
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        return readOnlyResponse({ error: "Usage stories are read-only." }, 405);
      }
      const rawUrl =
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url;
      const { pathname } = new URL(rawUrl, window.location.href);
      if (pathname === "/api/credential-profiles") {
        return readOnlyResponse({
          profiles: scenario === "empty" ? [] : usageProfiles,
        });
      }
      if (pathname === "/api/usage/claude") {
        if (scenario === "loading") return new Promise<Response>(() => {});
        if (scenario === "error") {
          return readOnlyResponse(
            { error: "Claude usage could not be refreshed." },
            503,
          );
        }
        return readOnlyResponse(claudeUsage);
      }
      if (pathname === "/api/usage/openai") {
        if (scenario === "loading") return new Promise<Response>(() => {});
        return readOnlyResponse(openAiUsage);
      }
      return readOnlyResponse({ error: "No fixture for this route." }, 404);
    };
    return () => {
      window.fetch = originalFetch;
    };
  }, [scenario]);
  return (
    <div className="h-dvh">
      <UsagePage />
    </div>
  );
}

function BackgroundPreview({
  items,
  stopPending = new Set<string>(),
  truncated = false,
}: {
  items: BackgroundWorkItemSummary[];
  stopPending?: ReadonlySet<string>;
  truncated?: boolean;
}) {
  return (
    <div className="h-dvh">
      <BackgroundTasksPage
        items={items}
        sessions={backgroundSessions}
        stopPending={stopPending}
        truncated={truncated}
        onStop={() => {}}
        onStopAllForOwner={() => {}}
        onOpenSession={() => {}}
      />
    </div>
  );
}

const meta = {
  title: "Settings/Usage and background work",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Usage: Story = {
  render: () => <UsagePreview scenario="populated" />,
};
export const UsageEmpty: Story = {
  render: () => <UsagePreview scenario="empty" />,
};
export const UsageLoading: Story = {
  render: () => <UsagePreview scenario="loading" />,
};
export const UsageError: Story = {
  render: () => <UsagePreview scenario="error" />,
};
export const UsageCreditsAndDialog: Story = {
  render: () => <UsagePreview scenario="credits" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Redeem a reset" }),
    );
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toBeInTheDocument();
  },
};
export const BackgroundProcesses: Story = {
  render: () => <BackgroundPreview items={backgroundWorks} />,
};
export const BackgroundEmpty: Story = {
  render: () => <BackgroundPreview items={[]} />,
};
export const BackgroundStopping: Story = {
  render: () => (
    <BackgroundPreview
      items={backgroundWorks}
      stopPending={new Set(["work-tests"])}
    />
  ),
};
export const BackgroundTruncated: Story = {
  render: () => <BackgroundPreview items={backgroundWorks} truncated />,
};
export const BackgroundLongLabel: Story = {
  render: () => <BackgroundPreview items={longBackgroundWork} />,
};
