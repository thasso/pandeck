import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ChatDockPanel } from "../../../src/components/ChatDockPanel.tsx";
import {
  StagedContextPanel,
  type StagedContextValue,
} from "../../../src/components/StagedContext.tsx";
import {
  PendingSessionPanel,
  SessionBootstrapNarration,
  SessionRefreshMark,
  UnavailableSessionPanel,
} from "../../../src/components/SessionStage.tsx";
import { chatProjects, chatWorktrees, noop } from "../../fixtures/chat.ts";
function PanelsPreview({
  state,
}: {
  state: "context" | "loading" | "unavailable" | "refresh" | "bootstrap-error";
}) {
  const [context, setContext] = useState<StagedContextValue>({
    projectId: "pandeck",
    worktreeId: "shadcn",
    task: null,
  });
  const [open, setOpen] = useState(true);
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
  if (state === "bootstrap-error")
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
  return (
    <div className="relative mx-auto mt-96 w-full max-w-xl">
      <ChatDockPanel
        open={open}
        title="Session context"
        onClose={() => setOpen(false)}
      >
        <StagedContextPanel
          value={context}
          projects={chatProjects}
          worktrees={chatWorktrees}
          tasks={[]}
          projectsLoaded
          worktreesLoaded
          tasksLoaded
          initialField="worktree"
          onChangeProject={(projectId) =>
            setContext((value) => ({ ...value, projectId }))
          }
          onChangeWorktree={(worktreeId) =>
            setContext((value) => ({ ...value, worktreeId }))
          }
          onChangeTask={(task) => setContext((value) => ({ ...value, task }))}
          onChangeNewWorktree={(newWorktree) =>
            setContext((value) => ({ ...value, newWorktree }))
          }
        />
      </ChatDockPanel>
    </div>
  );
}
const meta = {
  title: "App/Chat/Panels and loading",
  component: PanelsPreview,
  args: { state: "context" },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PanelsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ContextPicker = {} satisfies Story;
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
