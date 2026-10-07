import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentType, SessionMode, ThinkingLevel } from "@assistant/shared";
import { NewSessionQuickStart } from "../../../src/components/NewSessionQuickStart.tsx";
import {
  chatAccounts,
  chatModels,
  chatProjects,
  chatWorktrees,
  noop,
} from "../../fixtures/chat.ts";
function QuickStartPreview({
  state,
  frameWidth,
}: {
  state: "default" | "worktrees" | "loading" | "error";
  frameWidth: number;
}) {
  const [agent, setAgent] = useState<AgentType>("developer");
  const [mode, setMode] = useState<SessionMode>("build");
  const [project, setProject] = useState<string | null>("pandeck");
  const [worktree, setWorktree] = useState<string | null>(null);
  const [newWorktree, setNewWorktree] = useState(false);
  const [account, setAccount] = useState("claude-work");
  const [model, setModel] = useState(chatModels[0]);
  const [thinking, setThinking] = useState<ThinkingLevel>("high");
  return (
    <div
      style={{ width: frameWidth, maxWidth: "100%" }}
      className="flex justify-center bg-background pb-6"
    >
      <NewSessionQuickStart
        credentialProfiles={chatAccounts}
        credentialProfilesLoaded={state !== "loading"}
        credentialProfilesError={
          state === "error"
            ? "The provider account snapshot could not be refreshed."
            : undefined
        }
        onRetryCredentialProfiles={noop}
        selectedCredentialProfileId={account}
        onSelectCredentialProfile={setAccount}
        agentTypes={["developer", "workshop", "assistant"]}
        selectedAgentType={agent}
        onSelectAgentType={setAgent}
        mode={mode}
        onSelectMode={setMode}
        worktrees={state === "worktrees" ? chatWorktrees : []}
        worktreesLoaded={state !== "loading"}
        projects={chatProjects}
        projectsLoaded={state !== "loading"}
        selectedProjectId={project}
        onSelectProject={setProject}
        selectedWorktreeId={worktree}
        onSelectWorktree={setWorktree}
        newWorktreeStaged={newWorktree}
        onSelectNewWorktree={setNewWorktree}
        onOpenPicker={noop}
        models={chatModels}
        selectedModel={model}
        onSelectModel={setModel}
        thinkingLevel={thinking}
        onSelectThinking={setThinking}
      />
    </div>
  );
}
const meta = {
  title: "App/Chat/New session quick start",
  component: QuickStartPreview,
  args: { state: "default", frameWidth: 800 },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof QuickStartPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default = {} satisfies Story;
export const WithWorktrees = { args: { state: "worktrees" } } satisfies Story;
export const Loading = { args: { state: "loading" } } satisfies Story;
export const RefreshError = { args: { state: "error" } } satisfies Story;
export const Phone = {
  args: { state: "worktrees", frameWidth: 390 },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
