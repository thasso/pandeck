// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CredentialProfileSummary, ModelOption } from "@assistant/shared";
import { NewSessionQuickStart } from "./NewSessionQuickStart.tsx";

const profile: CredentialProfileSummary = {
  id: "claude-work",
  name: "Claude work",
  provider: "claude",
  enabled: true,
  status: "ready",
  createdAt: 1,
  updatedAt: 1,
};
const models: ModelOption[] = [
  {
    provider: "claude-sdk",
    id: "sonnet",
    name: "Sonnet",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium"],
    contextWindow: 200_000,
  },
  {
    provider: "claude-sdk",
    id: "opus",
    name: "Opus",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium"],
    contextWindow: 200_000,
  },
];

function render(
  overrides: {
    credentialProfilesLoaded?: boolean;
    credentialProfilesError?: string;
    credentialProfiles?: CredentialProfileSummary[];
    models?: ModelOption[];
  } = {},
): string {
  return renderToStaticMarkup(
    <NewSessionQuickStart
      credentialProfiles={overrides.credentialProfiles ?? [profile]}
      credentialProfilesLoaded={overrides.credentialProfilesLoaded ?? true}
      credentialProfilesError={overrides.credentialProfilesError}
      onRetryCredentialProfiles={() => {}}
      selectedCredentialProfileId={profile.id}
      onSelectCredentialProfile={() => {}}
      agentTypes={["assistant"]}
      selectedAgentType="assistant"
      onSelectAgentType={() => {}}
      worktrees={[]}
      worktreesLoaded
      projects={[]}
      projectsLoaded
      selectedProjectId={null}
      onSelectProject={() => {}}
      selectedWorktreeId={null}
      onSelectWorktree={() => {}}
      newWorktreeStaged={false}
      onSelectNewWorktree={() => {}}
      onOpenPicker={() => {}}
      models={overrides.models ?? models}
      selectedModel={(overrides.models ?? models)[0]}
      thinkingLevel="low"
      onSelectModel={() => {}}
      onSelectThinking={() => {}}
    />,
  );
}

describe("new-session loading states", () => {
  it("renders a cache-hydrated quick start with no loading narration", () => {
    const html = render();
    expect(html).toContain("Claude work");
    expect(html).toContain("Sonnet");
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Loading credential profiles");
  });

  it("keeps the hero mounted and reserves all runtime rows during first load", () => {
    const html = render({
      credentialProfilesLoaded: false,
      credentialProfiles: [],
      models: [],
    });
    expect(html).toContain("Start in a worktree");
    expect(html).toContain("Provider account");
    expect(html).toContain("Model");
    expect(html).toContain("Thinking");
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain(
      'aria-label="Loading credential profiles and models"',
    );
  });

  it("keeps loaded rows under one retryable ErrorNote after refresh failure", () => {
    const html = render({ credentialProfilesError: "network down" });
    expect(html).toContain(
      "Could not refresh credential profiles: network down",
    );
    expect(html).toContain("Claude work");
    expect(html).toContain("Sonnet");
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).not.toContain('role="status"');
  });
});
