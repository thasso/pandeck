import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentType, ThinkingLevel } from "@assistant/shared";
import { NewSessionQuickStart } from "../../../src/components/NewSessionQuickStart.tsx";
import {
  chatAccounts,
  chatModels,
  chatProjects,
  chatWorktrees,
  noop,
} from "../../fixtures/chat.ts";
import { settingsAgents } from "../../fixtures/settings.ts";
import {
  failed,
  loading,
  ready,
  refreshing,
} from "../../../src/lib/loadState.ts";
function QuickStartPreview({
  state,
  frameWidth,
  initialAccount = null,
  initialRequiresEnterprise = false,
  accounts = chatAccounts,
}: {
  state:
    | "default"
    | "worktrees"
    | "loading"
    | "error"
    | "agents"
    | "agentsLoading"
    | "agentsRefreshing"
    | "agentsError";
  frameWidth: number;
  /** Start on Automatic (null) or an explicit account. */
  initialAccount?: string | null;
  initialRequiresEnterprise?: boolean;
  accounts?: typeof chatAccounts;
}) {
  const [agent, setAgent] = useState<AgentType>("developer");
  const [project, setProject] = useState<string | null>("pandeck");
  const [worktree, setWorktree] = useState<string | null>(null);
  const [newWorktree, setNewWorktree] = useState(false);
  const [account, setAccount] = useState<string | null>(initialAccount);
  const [requiresEnterprise, setRequiresEnterprise] = useState(
    initialRequiresEnterprise,
  );
  const [model, setModel] = useState(chatModels[0]);
  const [thinking, setThinking] = useState<ThinkingLevel>("high");
  const [stagedAgent, setStagedAgent] = useState<string | null>(
    state === "agents" ? "test-reviewer" : null,
  );
  return (
    <div
      style={{ width: frameWidth, maxWidth: "100%" }}
      className="flex justify-center bg-background pb-6"
    >
      <NewSessionQuickStart
        credentialProfiles={accounts}
        credentialProfilesLoaded={state !== "loading"}
        credentialProfilesError={
          state === "error"
            ? "The provider account snapshot could not be refreshed."
            : undefined
        }
        onRetryCredentialProfiles={noop}
        selectedCredentialProfileId={account}
        onSelectCredentialProfile={setAccount}
        requiresEnterprise={requiresEnterprise}
        onRequiresEnterpriseChange={setRequiresEnterprise}
        agentTypes={["developer", "workshop", "assistant"]}
        selectedAgentType={agent}
        onSelectAgentType={setAgent}
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
        models={chatModels}
        selectedModel={model}
        onSelectModel={setModel}
        thinkingLevel={thinking}
        onSelectThinking={setThinking}
        agents={
          state === "agents"
            ? ready(settingsAgents)
            : state === "agentsLoading"
              ? loading()
              : state === "agentsRefreshing"
                ? refreshing(settingsAgents)
                : state === "agentsError"
                  ? failed("The agents library could not be read.")
                  : undefined
        }
        selectedAgent={stagedAgent}
        onSelectAgent={setStagedAgent}
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
export const ExplicitAccount = {
  args: { initialAccount: "claude-work" },
} satisfies Story;
export const RequiresEnterprise = {
  args: { initialRequiresEnterprise: true },
} satisfies Story;
export const RequiresEnterpriseWithoutEnterpriseAccount = {
  args: {
    initialRequiresEnterprise: true,
    accounts: chatAccounts.map((account) => ({
      ...account,
      enterprise: false,
    })),
  },
} satisfies Story;
export const Loading = { args: { state: "loading" } } satisfies Story;
export const RefreshError = { args: { state: "error" } } satisfies Story;
/** Agent definitions offered as a starting point; one cannot start. */
export const WithAgentDefinitions = {
  args: { state: "agents" },
} satisfies Story;
export const AgentDefinitionsLoading = {
  args: { state: "agentsLoading" },
} satisfies Story;
export const AgentDefinitionsRefreshing = {
  args: { state: "agentsRefreshing" },
} satisfies Story;
export const AgentDefinitionsError = {
  args: { state: "agentsError" },
} satisfies Story;
export const Phone = {
  args: { state: "worktrees", frameWidth: 390 },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
