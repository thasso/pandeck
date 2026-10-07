import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLayoutEffect, useState } from "react";
import { applyPatch, type AppSettings } from "@assistant/shared";
import type { Prefs } from "../../../src/hooks/usePrefs.ts";
import { SettingsPage } from "../../../src/components/SettingsPage.tsx";
import {
  settingsFixture,
  settingsMemory,
  settingsModels,
  settingsPrefs,
  settingsProfiles,
  settingsSkills,
} from "../../fixtures/settings.ts";
import { ready, loading, failFrom } from "../../../src/lib/loadState.ts";

const noop = () => {};
const healthy = { ok: true, message: "Connection is working.", checkedAt: 1 };
const baseArgs = {
  settings: settingsFixture,
  prefs: settingsPrefs,
  models: settingsModels,
  accountModels: settingsModels,
  credentialProfiles: settingsProfiles,
  projects: [],
  memory: settingsMemory,
  skills: ready(settingsSkills),
  serverBuild: { version: "1.4.0", commit: "abc1234", dirty: false },
  speechToText: {
    configured: true,
    availableModelIds: ["parakeet"],
    modelId: "parakeet",
    maxUtteranceSeconds: 120,
  },
  modelsRefreshing: false,
  onUpdate: noop,
  onUpdatePrefs: noop,
  onToggleSkill: noop,
  onRefreshModels: noop,
  onSaveAndTestJira: noop,
  onTestJira: noop,
  jiraStatus: healthy,
  onSaveAndTestConfluence: noop,
  onTestConfluence: noop,
  confluenceStatus: healthy,
  onUpdateTempo: noop,
  onSaveAndTestTempo: noop,
  onTestTempo: noop,
  tempoStatus: healthy,
  onUpdateGoogle: noop,
  onSaveAndTestGoogle: noop,
  onTestGoogle: noop,
  googleStatus: healthy,
  onSaveAndTestSlack: noop,
  onTestSlack: noop,
  slackStatus: healthy,
  onSaveAndTestOpenAiCompatible: noop,
  onTestOpenAiCompatible: noop,
  openAiCompatibleStatus: {
    ...healthy,
    models: settingsFixture.openAiCompatible.models,
  },
  onSaveAndTestBrave: noop,
  onTestBrave: noop,
  braveStatus: healthy,
  onSaveAndTestContext7: noop,
  onTestContext7: noop,
  context7Status: healthy,
  onSaveAndTestGithub: noop,
  onTestGithub: noop,
  githubStatus: healthy,
  onSaveAndTestForgejo: noop,
  onTestForgejo: noop,
  forgejoStatus: healthy,
} satisfies React.ComponentProps<typeof SettingsPage>;

function SettingsPreview(args: React.ComponentProps<typeof SettingsPage>) {
  const [settings, setSettings] = useState(args.settings);
  const [prefs, setPrefs] = useState(args.prefs);
  // Credential-profile pages read on mount. Serve fixture responses locally;
  // no story sends a request to the app or stores credentials.
  useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const readProfiles =
        url.includes("/api/credential-profiles") &&
        (!init?.method || init.method === "GET");
      return new Response(
        JSON.stringify(
          readProfiles
            ? { profiles: settingsProfiles }
            : { error: "Network actions are disabled in previews." },
        ),
        {
          status: readProfiles ? 200 : 405,
          headers: { "Content-Type": "application/json" },
        },
      );
    };
    return () => {
      window.fetch = original;
    };
  }, []);
  return (
    <div className="h-dvh">
      <SettingsPage
        {...args}
        settings={settings}
        prefs={prefs}
        onUpdate={(patch: Partial<AppSettings>) =>
          setSettings((current) => applyPatch(current, patch))
        }
        onUpdatePrefs={(patch: Partial<Prefs>) =>
          setPrefs((current) => ({ ...current, ...patch }))
        }
      />
    </div>
  );
}
const meta = {
  title: "App/Settings/Sections",
  component: SettingsPage,
  args: baseArgs,
  render: (args, context) => (
    <SettingsPreview
      {...args}
      key={`${context.globals.theme}-${context.globals.textScale}`}
      prefs={{
        ...args.prefs,
        theme: context.globals.theme === "dark" ? "dark" : "light",
        textScale: Number(
          context.globals.textScale ?? 100,
        ) as Prefs["textScale"],
      }}
    />
  ),
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Index: Story = {};
export const Profile: Story = { args: { section: "profile" } };
export const Appearance: Story = { args: { section: "appearance" } };
export const About: Story = { args: { section: "about" } };
export const Models: Story = { args: { section: "models" } };
export const ModelsEmpty: Story = {
  args: { section: "models", models: [], accountModels: [] },
};
export const ModelsRefreshing: Story = {
  args: { section: "models", modelsRefreshing: true },
};
export const ModelsHidden: Story = {
  args: {
    section: "models",
    settings: {
      ...settingsFixture,
      models: { hidden: ["openai-codex:gpt-5.4"], order: [] },
    },
  },
};
export const Claude: Story = { args: { section: "claude-sdk" } };
export const OpenAi: Story = { args: { section: "openai" } };
export const OpenAiCompatible: Story = {
  args: { section: "openai-compatible" },
};
export const PersonalAssistant: Story = {
  args: { section: "personal-assistant" },
};
export const Memory: Story = { args: { section: "memory" } };
export const KnowledgeBase: Story = { args: { section: "knowledge-base" } };
export const Naming: Story = { args: { section: "naming" } };
export const Refinement: Story = { args: { section: "refinement" } };
export const Dictation: Story = { args: { section: "dictation" } };
export const DictationEmpty: Story = {
  args: {
    section: "dictation",
    settings: {
      ...settingsFixture,
      speechToText: { ...settingsFixture.speechToText, vocabulary: [] },
    },
  },
};
export const Notifications: Story = { args: { section: "notifications" } };
export const Worktrees: Story = { args: { section: "worktrees" } };
export const Skills: Story = { args: { section: "skills" } };
export const SkillsLoading: Story = {
  args: { section: "skills", skills: loading() },
};
export const SkillsError: Story = {
  args: {
    section: "skills",
    skills: failFrom(
      ready(settingsSkills),
      "The skills folder could not be read.",
    ),
  },
};
export const PeerRuntimes: Story = { args: { section: "peer-runtimes" } };
export const PeerRuntimesEmpty: Story = {
  args: {
    section: "peer-runtimes",
    settings: { ...settingsFixture, peerSpawnRuntimes: [] },
  },
};
export const PeerRuntimesUnavailable: Story = {
  args: { section: "peer-runtimes", accountModels: [] },
};
export const BackgroundProcesses: Story = {
  args: { section: "background-processes" },
};
export const PortForwarding: Story = { args: { section: "port-forwarding" } };
export const Commit: Story = { args: { section: "commit" } };
export const PullRequest: Story = { args: { section: "pull-request" } };
export const TaskIntake: Story = { args: { section: "task-intake" } };
export const PdfConversion: Story = { args: { section: "pdf-conversion" } };
export const BrowserTools: Story = { args: { section: "browserTools" } };
export const Google: Story = { args: { section: "google" } };
export const GoogleError: Story = {
  args: {
    section: "google",
    googleStatus: {
      ...healthy,
      ok: false,
      message: "Your Google authorization has expired.",
    },
  },
};
export const Slack: Story = { args: { section: "slack" } };
export const Jira: Story = { args: { section: "jira" } };
export const Confluence: Story = { args: { section: "confluence" } };
export const Tempo: Story = { args: { section: "tempo" } };
export const Github: Story = { args: { section: "github" } };
export const Forgejo: Story = { args: { section: "forgejo" } };
export const WebSearch: Story = { args: { section: "web-search" } };
export const Context7: Story = { args: { section: "context7" } };
