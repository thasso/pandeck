import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  PendingSessionPanel,
  SessionBootstrapNarration,
  SessionRefreshMark,
  UnavailableSessionPanel,
} from "../../../src/components/SessionStage.tsx";
import { noop } from "../../fixtures/chat.ts";
function PanelsPreview({
  state,
}: {
  state: "loading" | "unavailable" | "refresh" | "bootstrap-error";
}) {
  if (state === "loading")
    return (
      <div className="flex h-96">
        <PendingSessionPanel title="Chat regression review" />
      </div>
    );
  if (state === "unavailable")
    return (
      <div className="flex h-96">
        <UnavailableSessionPanel
          title="Chat regression review"
          message="This session was removed. Choose another session from the sidebar."
        />
      </div>
    );
  if (state === "refresh")
    return (
      <div className="relative h-96">
        <SessionRefreshMark />
      </div>
    );
  return (
    <SessionBootstrapNarration
      narration={{
        kind: "failed",
        label: "Could not start this session",
        detail: "The worktree could not be created.",
      }}
      onRetry={noop}
    />
  );
}
const meta = {
  title: "App/Chat/Panels and loading",
  component: PanelsPreview,
  args: { state: "loading" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PanelsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const TranscriptLoading = { args: { state: "loading" } } satisfies Story;
export const TranscriptUnavailable = {
  args: { state: "unavailable" },
} satisfies Story;
export const TranscriptRefreshing = {
  args: { state: "refresh" },
} satisfies Story;
export const SessionStartError = {
  args: { state: "bootstrap-error" },
} satisfies Story;
