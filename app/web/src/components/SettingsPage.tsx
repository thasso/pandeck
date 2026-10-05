import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  type AccountModelOption,
  type AppSettings,
  type BraveConnectionStatus,
  type BraveSettingsPatch,
  type OpenAiCompatibleConnectionStatus,
  type OpenAiCompatibleSettingsPatch,
  type OpenAiCompatibleThinkingFormat,
  type Context7ConnectionStatus,
  type Context7SettingsPatch,
  type GithubConnectionStatus,
  type GithubSettingsPatch,
  type ForgejoConnectionStatus,
  type ForgejoSettingsPatch,
  type GoogleConnectionStatus,
  type GoogleSettingsPatch,
  type ConfluenceConnectionStatus,
  type ConfluenceSettingsPatch,
  type JiraConnectionStatus,
  type JiraSettingsPatch,
  type ModelOption,
  type ProjectRecord,
  type SkillLibraryList,
  type SlackConnectionStatus,
  type SlackHuddleConnectionStatus,
  type SlackSettingsPatch,
  type SpeechToTextStatus,
  type SpeechVocabularyEntry,
  type TempoConnectionStatus,
  type TempoSettingsPatch,
  applySpeechVocabulary,
  modelKey,
  CLAUDE_SDK_PROVIDER,
  OPENAI_COMPATIBLE_THINKING_FORMATS,
  type CredentialProfileProvider,
  type CredentialProfileSummary,
} from "@assistant/shared";
import { visibleModels } from "../lib/models.ts";
import { Disclosure } from "./Disclosure.tsx";
import {
  clearRecentTranscripts,
  recentTranscripts,
  transcriptAge,
  type RecentTranscript,
} from "../lib/recentTranscripts.ts";
import { isValidTimezone } from "../lib/timezone.ts";
import type { BuildInfo } from "@assistant/shared/buildInfo";
import { serverHttpOrigin } from "../lib/serverOrigin.ts";
import { startGoogleOAuth } from "../lib/googleOAuth.ts";
import { settingBounds } from "@assistant/shared/settingsRegistry";
import { RegistrySettingFields } from "./RegistrySettingFields.tsx";
import {
  createCredentialProfile,
  disableAccountImpact,
  deleteCredentialProfile,
  fetchCredentialProfiles,
  openAiProfileConnectionAction,
  renameCredentialProfile,
  setCredentialProfileEnabled,
  startOpenAiProfileLogin,
} from "../lib/credentialProfiles.ts";
import type { Prefs, TextScale } from "../hooks/usePrefs.ts";
import type { SettingsSection } from "../hooks/useSessionRouting.ts";
import type { NavSlot } from "../hooks/useSidebarSection.ts";
import { usePointerReorder } from "../hooks/usePointerReorder.ts";
import { PageHeader, type PageHeaderBack } from "./PageHeader.tsx";
import { PRIMARY_NAV_SLOTS } from "./primaryNavSections.tsx";
import { planNavSlots } from "./shell/navOverflow.ts";
import { viewportWidth } from "./shell/panelSizing.ts";
import { useMobileLayout } from "./shell/useMobileLayout.ts";
import { SETTINGS_SECTIONS } from "./settingsSections.tsx";
import {
  AgentModelFields,
  CredentialProfilesContext,
} from "./AgentModelFields.tsx";
import { MemorySettingsSection as MemorySection } from "./MemorySettingsSection.tsx";
import { PeerRuntimesSettingsSection } from "./PeerRuntimesSettingsSection.tsx";
import { BackgroundProcessesSettingsSection } from "./BackgroundProcessesSettingsSection.tsx";
import { PortForwardingSettingsSection } from "./PortForwardingSettingsSection.tsx";
import { SkillsSettingsSection } from "./SkillsSettingsSection.tsx";
import { AboutSettingsSection } from "./AboutSettingsSection.tsx";
import { PushNotificationsSection } from "./PushNotificationsSection.tsx";
import { ClaudeLoginTerminal } from "./ClaudeLoginTerminal.tsx";
import { ErrorNote, Spinner } from "./ui/load.tsx";
import { Button } from "./ui/Button.tsx";
import { useDialogs } from "./ui/dialog.tsx";
import type { UseMemory } from "../hooks/useMemory.ts";
import type { LoadState } from "../lib/loadState.ts";

interface Props {
  /** Global model list, used by the account-independent Models section. */
  models: ModelOption[];
  /**
   * Account/model combinations offered to configurable agents. Choosing one
   * pins both the model and the provider account the agent runs on.
   */
  accountModels: AccountModelOption[];
  /** Accounts themselves, so a slot pinned to a disabled/removed one can say so. */
  credentialProfiles: CredentialProfileSummary[];
  projects: ProjectRecord[];
  settings: AppSettings;
  memory: UseMemory;
  /** The `skills` topic's canonical load state; only the Skills section reads it. */
  skills: LoadState<SkillLibraryList>;
  prefs: Prefs;
  /**
   * The section to render. Absent on the `/settings` index route, where the
   * section list is the browser and this page is only a hint.
   */
  section?: SectionId | undefined;
  /** Mobile screen back control (ui-shell.md, Small Screens). */
  back?: PageHeaderBack | undefined;
  /** Navigate to another settings section (account pages link to pinned slots). */
  onOpenSection?: (section: SectionId) => void;
  /** Deployment dictation availability, recomputed by the server after each save. */
  speechToText: SpeechToTextStatus | null;
  /** The server's build, for the About section; null before this client connected. */
  serverBuild: BuildInfo | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
  /**
   * One skill at a time: the whole-section replacement is built in
   * `useAssistant`, and nothing changes on screen before the settings echo.
   */
  onToggleSkill: (name: string, on: boolean) => void;
  onUpdatePrefs: (patch: Partial<Prefs>) => void;
  onRefreshModels: () => void;
  /** A refresh is out. It usually returns the same list, so this is the receipt. */
  modelsRefreshing: boolean;
  onSaveAndTestJira: (patch: JiraSettingsPatch) => void;
  onTestJira: () => void;
  jiraStatus: JiraConnectionStatus | null;
  onSaveAndTestConfluence: (patch: ConfluenceSettingsPatch) => void;
  onTestConfluence: () => void;
  confluenceStatus: ConfluenceConnectionStatus | null;
  onUpdateTempo: (patch: TempoSettingsPatch) => void;
  onSaveAndTestTempo: (patch: TempoSettingsPatch) => void;
  onTestTempo: () => void;
  tempoStatus: TempoConnectionStatus | null;
  onUpdateGoogle: (patch: GoogleSettingsPatch) => void;
  onSaveAndTestGoogle: (patch: GoogleSettingsPatch) => void;
  onTestGoogle: () => void;
  googleStatus: GoogleConnectionStatus | null;
  onSaveAndTestSlack: (patch: SlackSettingsPatch) => void;
  onTestSlack: () => void;
  slackStatus: SlackConnectionStatus | null;
  onSaveAndTestSlackHuddles: (patch: SlackSettingsPatch) => void;
  onTestSlackHuddles: () => void;
  slackHuddleStatus: SlackHuddleConnectionStatus | null;
  onSaveAndTestOpenAiCompatible: (patch: OpenAiCompatibleSettingsPatch) => void;
  onTestOpenAiCompatible: () => void;
  openAiCompatibleStatus: OpenAiCompatibleConnectionStatus | null;
  onSaveAndTestBrave: (patch: BraveSettingsPatch) => void;
  onTestBrave: () => void;
  braveStatus: BraveConnectionStatus | null;
  onSaveAndTestContext7: (patch: Context7SettingsPatch) => void;
  onTestContext7: () => void;
  context7Status: Context7ConnectionStatus | null;
  onSaveAndTestGithub: (patch: GithubSettingsPatch) => void;
  onTestGithub: () => void;
  githubStatus: GithubConnectionStatus | null;
  onSaveAndTestForgejo: (patch: ForgejoSettingsPatch) => void;
  onTestForgejo: () => void;
  forgejoStatus: ForgejoConnectionStatus | null;
}

type SectionId = SettingsSection;

export function SettingsPage({
  models,
  accountModels,
  credentialProfiles,
  onOpenSection,
  projects,
  settings,
  memory,
  skills,
  prefs,
  section,
  back,
  speechToText,
  serverBuild,
  onUpdate,
  onToggleSkill,
  onUpdatePrefs,
  onRefreshModels,
  modelsRefreshing,
  onSaveAndTestJira,
  onTestJira,
  jiraStatus,
  onSaveAndTestConfluence,
  onTestConfluence,
  confluenceStatus,
  onUpdateTempo,
  onSaveAndTestTempo,
  onTestTempo,
  tempoStatus,
  onUpdateGoogle,
  onSaveAndTestGoogle,
  onTestGoogle,
  googleStatus,
  onSaveAndTestSlack,
  onTestSlack,
  slackStatus,
  onSaveAndTestSlackHuddles,
  onTestSlackHuddles,
  slackHuddleStatus,
  onSaveAndTestOpenAiCompatible,
  onTestOpenAiCompatible,
  openAiCompatibleStatus,
  onSaveAndTestBrave,
  onTestBrave,
  braveStatus,
  onSaveAndTestContext7,
  onTestContext7,
  context7Status,
  onSaveAndTestGithub,
  onTestGithub,
  githubStatus,
  onSaveAndTestForgejo,
  onTestForgejo,
  forgejoStatus,
}: Props) {
  const currentSection = SETTINGS_SECTIONS.find((s) => s.id === section);
  // Configurable agents choose an account/model combination; the plain global
  // list stays for the account-independent Models section (visibility/order).
  const agentModels = accountModels;
  return (
    <CredentialProfilesContext.Provider value={credentialProfiles}>
      <div className="flex h-full w-full flex-col bg-surface text-fg">
        <PageHeader
          back={back}
          icon={<Settings size={16} />}
          iconTone="accent"
          title={currentSection?.label ?? "Settings"}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {section === "about" && (
            <AboutSettingsSection serverBuild={serverBuild} />
          )}
          {section === "profile" && (
            <ProfileSection settings={settings} onUpdate={onUpdate} />
          )}
          {section === "appearance" && (
            <AppearanceSection
              prefs={prefs}
              onUpdate={onUpdatePrefs}
              settings={settings}
              onUpdateSettings={onUpdate}
            />
          )}
          {section === "models" && (
            <ModelsSection
              models={models}
              settings={settings}
              onUpdate={onUpdate}
              onRefresh={onRefreshModels}
              refreshing={modelsRefreshing}
            />
          )}
          {section === "personal-assistant" && (
            <PermanentAssistantSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "memory" && (
            <MemorySection
              models={agentModels}
              settings={settings}
              memory={memory}
              onUpdate={onUpdate}
            />
          )}
          {section === "naming" && (
            <SessionNamingSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "commit" && (
            <CommitAgentSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "pull-request" && (
            <PrAgentSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "worktrees" && (
            <WorktreesSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "skills" && (
            <SkillsSettingsSection
              library={skills}
              settings={settings}
              onToggleSkill={onToggleSkill}
            />
          )}
          {section === "peer-runtimes" && (
            <PeerRuntimesSettingsSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "background-processes" && (
            <BackgroundProcessesSettingsSection
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "port-forwarding" && <PortForwardingSettingsSection />}
          {section === "refinement" && (
            <PromptRefinementSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "dictation" && (
            <DictationSection
              settings={settings}
              status={speechToText}
              onUpdate={onUpdate}
            />
          )}
          {section === "notifications" && <PushNotificationsSection />}
          {section === "task-intake" && (
            <TaskIntakeAgentSection
              models={agentModels}
              projects={projects}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "browserTools" && (
            <BrowserToolsSettingsSection
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "jira" && (
            <JiraCard
              settings={settings}
              status={jiraStatus}
              onSaveAndTest={onSaveAndTestJira}
              onTest={onTestJira}
            />
          )}
          {section === "confluence" && (
            <ConfluenceCard
              settings={settings}
              status={confluenceStatus}
              onSaveAndTest={onSaveAndTestConfluence}
              onTest={onTestConfluence}
            />
          )}
          {section === "tempo" && (
            <TempoCard
              settings={settings}
              status={tempoStatus}
              onUpdate={onUpdateTempo}
              onSaveAndTest={onSaveAndTestTempo}
              onTest={onTestTempo}
            />
          )}
          {section === "google" && (
            <GoogleWorkspaceSection
              settings={settings}
              status={googleStatus}
              onUpdateGoogle={onUpdateGoogle}
              onSaveAndTestGoogle={onSaveAndTestGoogle}
              onTestGoogle={onTestGoogle}
            />
          )}
          {section === "minutes-scanner" && (
            <MeetingMinutesScannerSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "day-scan" && (
            <DayScanSection settings={settings} onUpdate={onUpdate} />
          )}
          {section === "pdf-conversion" && (
            <PdfConversionSection
              models={agentModels}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {section === "slack" && (
            <SlackSection
              settings={settings}
              status={slackStatus}
              onSaveAndTestSlack={onSaveAndTestSlack}
              onTestSlack={onTestSlack}
            />
          )}
          {section === "slack-huddles" && (
            <SlackHuddlesSection
              settings={settings}
              status={slackHuddleStatus}
              onSaveAndTestSlack={onSaveAndTestSlackHuddles}
              onTestSlack={onTestSlackHuddles}
            />
          )}
          {section === "openai-compatible" && (
            <OpenAiCompatibleSection
              settings={settings}
              status={openAiCompatibleStatus}
              onSaveAndTestOpenAiCompatible={onSaveAndTestOpenAiCompatible}
              onTestOpenAiCompatible={onTestOpenAiCompatible}
            />
          )}
          {section === "web-search" && (
            <BraveSection
              settings={settings}
              status={braveStatus}
              onSaveAndTestBrave={onSaveAndTestBrave}
              onTestBrave={onTestBrave}
            />
          )}
          {section === "context7" && (
            <Context7Section
              settings={settings}
              status={context7Status}
              onSaveAndTestContext7={onSaveAndTestContext7}
              onTestContext7={onTestContext7}
            />
          )}
          {section === "github" && (
            <GithubSection
              settings={settings}
              status={githubStatus}
              onSaveAndTestGithub={onSaveAndTestGithub}
              onTestGithub={onTestGithub}
            />
          )}
          {section === "forgejo" && (
            <ForgejoSection
              settings={settings}
              status={forgejoStatus}
              onSaveAndTestForgejo={onSaveAndTestForgejo}
              onTestForgejo={onTestForgejo}
            />
          )}
          {section === "claude-sdk" && (
            <>
              <ClaudeSdkSection settings={settings} onUpdate={onUpdate} />
              <CredentialProfilesSection
                provider="claude"
                onOpenSection={onOpenSection}
              />
            </>
          )}
          {section === "openai" && (
            <>
              <OpenAiSection />
              <CredentialProfilesSection
                provider="openai-codex"
                onOpenSection={onOpenSection}
              />
            </>
          )}
          {/* What the section's own UI does not show, from the registry. */}
          {currentSection && (
            <RegistrySettingFields
              section={currentSection.id}
              settings={settings}
              onUpdate={onUpdate}
            />
          )}
          {/* Index route: the section list is the browser, not this page. */}
          {!currentSection && (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8 text-center text-body text-muted">
              Pick a settings section in the Settings browser.
            </div>
          )}
        </div>
      </div>
    </CredentialProfilesContext.Provider>
  );
}

function ClaudeSdkSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const sdk = settings.claudeSdk;
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Claude SDK</h2>
      <p className="mt-1 text-caption text-muted">
        Enable Claude via the Agent SDK — an in-process Claude agent driven
        through the normal chat composer: prompts, model, and thinking level are
        sent straight to the SDK session with full tool access.
      </p>
      <p className="mt-2 text-caption text-muted">
        Authentication uses the isolated Claude profiles configured below.
        Follow a profile's setup command to sign in with the intended account.
        Model, thinking level, and profile lock after the session's first turn.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={sdk.enabled}
            onChange={(e) =>
              onUpdate({ claudeSdk: { ...sdk, enabled: e.target.checked } })
            }
            className="size-4 accent-accent"
          />
          Enable Claude SDK sessions
        </label>
        <p className="text-caption text-muted">
          When enabled, a new Claude SDK session can be started from the sidebar
          and appears in the Sessions list alongside Assistant and Workshop
          sessions.
        </p>
      </div>
    </div>
  );
}

function OpenAiSection() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">OpenAI</h2>
      <p className="mt-1 text-caption text-muted">
        Connect one or more OpenAI/Codex subscription accounts for pi-powered
        assistant sessions. Each profile keeps its credentials isolated and can
        be selected before a session starts.
      </p>
    </div>
  );
}

export function credentialProfilesForProvider(
  profiles: CredentialProfileSummary[],
  provider: CredentialProfileProvider,
): CredentialProfileSummary[] {
  return profiles.filter((profile) => profile.provider === provider);
}

export function CredentialProfileCard({
  profile,
  providerLabel,
  connectionLabel,
  connectionDisabled,
  onToggle,
  onConnect,
  onRename,
  onDelete,
  onOpenSection,
}: {
  profile: CredentialProfileSummary;
  providerLabel: string;
  connectionLabel: string;
  connectionDisabled?: boolean;
  onToggle: () => void;
  onConnect: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  /** Navigate to the settings section owning a pinned slot. */
  onOpenSection?: ((section: SectionId) => void) | undefined;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-medium text-fg">
            {profile.name}
          </p>
          <p className="text-caption text-faint">
            {providerLabel} · {profile.enabled ? profile.status : "disabled"}
          </p>
        </div>
        {onRename || onDelete ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onRename ? (
              <button
                type="button"
                onClick={onRename}
                className="rounded-lg p-2 text-muted hover:bg-raised hover:text-fg"
                aria-label={`Rename ${profile.name}`}
                title="Rename profile"
              >
                <Pencil size={14} />
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className="rounded-lg p-2 text-danger hover:bg-danger/10"
                aria-label={`Delete ${profile.name}`}
                title="Delete profile"
              >
                <Trash2 size={14} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={profile.enabled}
          aria-label={`${profile.enabled ? "Disable" : "Enable"} ${profile.name}`}
          onClick={onToggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${profile.enabled ? "bg-accent" : "bg-line"}`}
        >
          <span
            className={`absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${profile.enabled ? "translate-x-5" : "translate-x-0.5"}`}
          />
        </button>
        <button
          type="button"
          disabled={connectionDisabled}
          onClick={onConnect}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-caption hover:bg-raised disabled:opacity-50"
        >
          {profile.status === "connecting" ? (
            <Spinner size="sm" />
          ) : (
            <RefreshCw size={13} className="shrink-0" />
          )}
          <span className="truncate">{connectionLabel}</span>
        </button>
      </div>
      {profile.setup ? (
        <div className="mt-2 rounded bg-raised p-2 text-caption text-muted">
          <p>{profile.setup.detail}</p>
          {profile.setup.verificationUri ? (
            <a
              href={profile.setup.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-accent underline"
            >
              {profile.setup.verificationUri}
            </a>
          ) : null}
          {profile.setup.userCode ? (
            <p className="mt-1 font-mono text-fg">
              Code: {profile.setup.userCode}
            </p>
          ) : null}
          {profile.setup.command ? (
            <code className="mt-2 block break-all text-fg">
              {profile.setup.command}
            </code>
          ) : null}
        </div>
      ) : null}
      {profile.error ? (
        <p className="mt-2 text-caption text-danger">{profile.error}</p>
      ) : null}
      <CredentialProfileUsageBlock
        profile={profile}
        onOpenSection={onOpenSection}
      />
    </div>
  );
}

/**
 * Where this account is used, so disabling or deleting it is an informed
 * decision: the settings slots pinned to it (each a link to the section that
 * owns it), the sessions bound to it, and whether it is the account unpinned
 * work currently runs on.
 */
function CredentialProfileUsageBlock({
  profile,
  onOpenSection,
}: {
  profile: CredentialProfileSummary;
  onOpenSection?: ((section: SectionId) => void) | undefined;
}) {
  const usage = profile.usage;
  if (!usage) return null;
  const {
    pinnedSlots,
    boundSessionCount,
    automaticForProvider,
    automaticFallback,
  } = usage;
  if (
    pinnedSlots.length === 0 &&
    boundSessionCount === 0 &&
    !automaticForProvider
  )
    return null;
  return (
    <div className="mt-2 rounded bg-raised p-2 text-caption text-muted">
      <p className="font-medium text-fg">Used by</p>
      {automaticForProvider ? (
        <p className="mt-1">
          Automatic account for unpinned work
          {automaticFallback ? (
            <> · would move to “{automaticFallback.name}”</>
          ) : null}
        </p>
      ) : null}
      {boundSessionCount > 0 ? (
        <p className="mt-1">
          {boundSessionCount} bound{" "}
          {boundSessionCount === 1 ? "session" : "sessions"} — they keep running
          on it even when disabled
        </p>
      ) : null}
      {pinnedSlots.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span>Pinned by:</span>
          {pinnedSlots.map((slot) => (
            <button
              key={slot.key}
              type="button"
              onClick={() => onOpenSection?.(slot.section as SectionId)}
              className="rounded border border-line px-1.5 py-0.5 text-fg hover:bg-surface"
            >
              {slot.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CredentialProfilesSection({
  provider,
  onOpenSection,
}: {
  provider: CredentialProfileProvider;
  onOpenSection?: ((section: SectionId) => void) | undefined;
}) {
  const dialogs = useDialogs();
  const [profiles, setProfiles] = useState<CredentialProfileSummary[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [claudeLoginProfile, setClaudeLoginProfile] =
    useState<CredentialProfileSummary | null>(null);
  const refresh = async () => {
    try {
      setProfiles(await fetchCredentialProfiles({ includeUsage: true }));
      window.dispatchEvent(new Event("credentialProfilesChanged"));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  const providerProfiles = credentialProfilesForProvider(profiles, provider);
  useEffect(() => {
    if (
      !profiles.some(
        (profile) =>
          profile.provider === provider && profile.status === "connecting",
      )
    )
      return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [profiles, provider]);
  const add = async () => {
    try {
      await createCredentialProfile(name, provider);
      setName("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const providerLabel = provider === "claude" ? "Claude" : "OpenAI";
  return (
    <>
      <div className="mx-auto max-w-2xl px-6 pb-6">
        <div className="rounded-xl border border-line bg-panel p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-body font-semibold">
                {providerLabel} profiles
              </h3>
              <p className="mt-1 text-caption text-muted">
                Profiles are isolated under PA data. Tokens never enter the
                browser or app settings.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg p-2 text-muted hover:bg-raised hover:text-fg"
              title={`Refresh ${providerLabel} profiles`}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${providerLabel} profile name`}
              className="settings-input min-w-[12rem] flex-1"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={!name.trim()}
              className="rounded-lg bg-accent px-3 py-1.5 text-caption font-medium text-accent-fg disabled:opacity-40"
            >
              Add {providerLabel} profile
            </button>
          </div>
          {error ? (
            <ErrorNote
              className="mt-3"
              message={error}
              onRetry={() => void refresh()}
            />
          ) : null}
          <div className="mt-4 space-y-2">
            {providerProfiles.map((profile) => {
              const protectedProfile =
                profile.id === "default" || profile.id === "claude-default";
              const connection =
                provider === "openai-codex"
                  ? openAiProfileConnectionAction(profile.status)
                  : {
                      label:
                        profile.status === "connecting"
                          ? "Continue login"
                          : profile.status === "ready"
                            ? "Reconnect"
                            : "Connect",
                      disabled: false,
                    };
              const fail = (err: unknown) =>
                setError(err instanceof Error ? err.message : String(err));
              // Each asks first, then writes. The ask settles rather than
              // rejecting and every write ends in `.catch(fail)`, so the card's
              // `() => void` slots take them through a `void` call.
              const toggle = async () => {
                // Enabling is always safe; disabling reroutes work, so it is
                // confirmed with exactly what moves and what keeps running.
                if (profile.enabled) {
                  const impact = disableAccountImpact(profile);
                  const confirmed = await dialogs.confirm({
                    title: `Disable “${profile.name}”?`,
                    body: impact.length ? (
                      <>
                        {impact.map((line) => (
                          <p key={line}>{line}</p>
                        ))}
                      </>
                    ) : undefined,
                    confirmLabel: "Disable",
                  });
                  if (!confirmed) return;
                }
                void setCredentialProfileEnabled(profile.id, !profile.enabled)
                  .then(refresh)
                  .catch(fail);
              };
              const rename = async () => {
                const next = await dialogs.promptText({
                  title: "Rename credential profile",
                  label: "Profile name",
                  defaultValue: profile.name,
                });
                if (next)
                  void renameCredentialProfile(profile.id, next)
                    .then(refresh)
                    .catch(fail);
              };
              const remove = async () => {
                const pinned = profile.usage?.pinnedSlots ?? [];
                const confirmed = await dialogs.confirm({
                  title: `Delete credential profile “${profile.name}”?`,
                  body: pinned.length
                    ? `${pinned.length} settings ${pinned.length === 1 ? "slot returns" : "slots return"} to the automatic account: ${pinned.map((slot) => slot.label).join(", ")}.`
                    : undefined,
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (confirmed)
                  void deleteCredentialProfile(profile.id)
                    .then(refresh)
                    .catch(fail);
              };
              return (
                <CredentialProfileCard
                  key={profile.id}
                  profile={profile}
                  providerLabel={providerLabel}
                  connectionLabel={connection.label}
                  connectionDisabled={connection.disabled}
                  onToggle={() => void toggle()}
                  onOpenSection={onOpenSection}
                  onConnect={() => {
                    if (provider === "claude") setClaudeLoginProfile(profile);
                    else
                      void startOpenAiProfileLogin(profile.id)
                        .then(refresh)
                        .catch(fail);
                  }}
                  {...(!protectedProfile
                    ? {
                        onRename: () => void rename(),
                        onDelete: () => void remove(),
                      }
                    : {})}
                />
              );
            })}
          </div>
        </div>
      </div>
      {claudeLoginProfile ? (
        <ClaudeLoginTerminal
          profile={claudeLoginProfile}
          onFinished={() => void refresh()}
          onClose={() => {
            setClaudeLoginProfile(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ProfileSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const profile = settings.profile;
  // Drafts commit on blur, so a half-typed zone is never saved (the server
  // would normalize it to "follow the server" on every keystroke).
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [timeZone, setTimeZone] = useState(profile.timeZone);
  useEffect(() => setDisplayName(profile.displayName), [profile.displayName]);
  useEffect(() => setTimeZone(profile.timeZone), [profile.timeZone]);
  const save = (patch: Partial<typeof profile>) =>
    onUpdate({ profile: { ...profile, ...patch } });
  const zoneDraft = timeZone.trim();
  const zoneValid = zoneDraft === "" || isValidTimezone(zoneDraft);
  // With no zone of its own the server reports its host's zone as effective.
  const serverZone = profile.timeZone ? null : profile.effectiveTimeZone;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Profile</h2>
      <p className="mt-1 text-caption text-muted">
        Who the assistant works for. The timezone decides what
        &ldquo;today&rdquo; means everywhere: the calendar, Task planning, the
        day scan and its morning run, memory reminders, and the local times
        tools report.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <Field label="Name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => {
              if (displayName.trim() !== profile.displayName)
                save({ displayName: displayName.trim() });
            }}
            placeholder="Your name"
            className="settings-input"
          />
          <p className="mt-1 text-caption text-faint">
            Used to name you in meeting-minutes extraction and on your new
            comments. Left empty, you are &ldquo;the user&rdquo; and comments
            read &ldquo;You&rdquo;.
          </p>
        </Field>
        <Field label="Timezone">
          <input
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            onBlur={() => {
              if (!zoneValid) return;
              if (zoneDraft !== profile.timeZone) save({ timeZone: zoneDraft });
            }}
            placeholder={
              serverZone ? `Follow server (${serverZone})` : "Follow server"
            }
            aria-invalid={!zoneValid}
            className="settings-input"
          />
          {zoneValid ? (
            <p className="mt-1 text-caption text-faint">
              An IANA timezone such as America/New_York. Leave it empty to
              follow the server. In effect: {profile.effectiveTimeZone}.
            </p>
          ) : (
            <p className="mt-1 text-caption text-danger">
              Not a valid IANA timezone; it is not saved until corrected.
            </p>
          )}
        </Field>
      </div>
    </div>
  );
}

function AppearanceSection({
  prefs,
  onUpdate,
  settings,
  onUpdateSettings,
}: {
  prefs: Prefs;
  onUpdate: (patch: Partial<Prefs>) => void;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
}) {
  const appearance = settings.appearance;
  const saveAppearance = (patch: Partial<AppSettings["appearance"]>) =>
    onUpdateSettings({ appearance: { ...appearance, ...patch } });
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-heading font-semibold">Appearance</h2>
      <p className="mt-1 text-caption text-muted">
        Adjust your interface and choose which optional panels to show.
      </p>

      <div className="mt-6 space-y-3 rounded-xl border border-line bg-panel p-4">
        <h3 className="text-body font-semibold text-fg">Theme</h3>
        <p className="text-caption text-muted">
          The color theme for this browser. On a wide layout the header's
          sun/moon button flips the same preference; a phone has no app header,
          so this is the only place.
        </p>
        <Field label="Theme">
          <select
            value={prefs.theme}
            onChange={(e) =>
              onUpdate({ theme: e.target.value as Prefs["theme"] })
            }
            className="settings-input"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </Field>
      </div>

      <div className="mt-5 space-y-3 rounded-xl border border-line bg-panel p-4">
        <h3 className="text-body font-semibold text-fg">Text size</h3>
        <p className="text-caption text-muted">
          Scale the interface typography for this browser only. Larger sizes
          affect text alone — panel widths, spacing, and icons stay the same.
          Saved locally and applied instantly.
        </p>
        <TextSizeControl
          value={prefs.textScale}
          onChange={(textScale) => onUpdate({ textScale })}
        />
      </div>

      <div className="mt-5 space-y-3 rounded-xl border border-line bg-panel p-4">
        <h3 className="text-body font-semibold text-fg">
          Navigation bar order
        </h3>
        <p className="text-caption text-muted">
          Order the sidebar's bottom navigation bar — the sections and the
          app-level actions (New Session, the Personal Assistant, Usage) share
          it. It shows as many entries as fit at its current width and folds the
          rest into the “More” menu, so whatever you put first is what stays one
          tap away. Saved locally for this browser.
        </p>
        <NavOrderControl
          order={prefs.navSlots}
          sidebarWidth={prefs.sidebarWidth}
          onChange={(navSlots) => onUpdate({ navSlots })}
        />
      </div>

      <div className="mt-5 space-y-5 rounded-xl border border-line bg-panel p-4">
        <div className="space-y-3">
          <h3 className="text-body font-semibold text-fg">Panel animations</h3>
          <p className="text-caption text-muted">
            Slide side panels in quickly when they open. These settings are
            separate so the navigation sidebar and the object panel can be tuned
            independently.
          </p>
          <PreferenceToggle
            checked={prefs.animateLeftSidebar}
            onChange={(checked) => onUpdate({ animateLeftSidebar: checked })}
            label="Animate left sidebar"
            description="Slide the Sessions sidebar in from the left."
          />
          <PreferenceToggle
            checked={prefs.animateRightDrawer}
            onChange={(checked) => onUpdate({ animateRightDrawer: checked })}
            label="Animate object panel"
            description="Slide the Details panel in from the right, and expand the object dock on a phone."
          />
          <PreferenceToggle
            checked={prefs.animateListChanges}
            onChange={(checked) => onUpdate({ animateListChanges: checked })}
            label="Animate list changes"
            description="In the Sessions inbox: slide a settled card out to the left before the rows below it close the gap, and let a card that changes place travel there instead of jumping."
          />
        </div>
      </div>

      <div className="mt-5 space-y-3 rounded-xl border border-line bg-panel p-4">
        <h3 className="text-body font-semibold text-fg">Right panel</h3>
        <p className="text-caption text-muted">
          Choose which optional spaces appear in navigation. Their features
          remain available through links and tools when hidden here.
        </p>
        <PreferenceToggle
          checked={appearance.knowledgePanelEnabled}
          onChange={(checked) =>
            saveAppearance({ knowledgePanelEnabled: checked })
          }
          label="Show Knowledge"
          description="Add Knowledge to the sidebar and right-panel picker. The Knowledge Base remains available through links and tools."
        />
        <PreferenceToggle
          checked={appearance.worktreePanelEnabled}
          onChange={(checked) =>
            saveAppearance({ worktreePanelEnabled: checked })
          }
          label="Show Worktree panel"
          description="Add Worktree to the right-panel picker. Worktrees remain available elsewhere."
        />
      </div>

      <div className="mt-5 space-y-5 rounded-xl border border-line bg-panel p-4">
        <div className="space-y-3">
          <h3 className="text-caption font-semibold text-fg">
            Chat transcript
          </h3>
          <p className="text-caption text-muted">
            Make turn boundaries and token/cost usage visible in the chat. These
            are display-only and shared across your browsers; they never change
            prompts or the stored conversation.
          </p>
          <PreferenceToggle
            checked={appearance.separatorBeforeFinalResponse}
            onChange={(checked) =>
              saveAppearance({ separatorBeforeFinalResponse: checked })
            }
            label="Separator before the final response"
            description="Draw a rule where the tool loop ends and the final answer begins (only on turns that used tools)."
          />
          <PreferenceToggle
            checked={appearance.separatorAtTurnEnd}
            onChange={(checked) =>
              saveAppearance({ separatorAtTurnEnd: checked })
            }
            label="Separator at turn end"
            description="Draw a rule after each completed turn, marking the boundary between turns."
          />
          <PreferenceToggle
            checked={appearance.turnStatsRow}
            onChange={(checked) => saveAppearance({ turnStatsRow: checked })}
            label="Turn & session stats row"
            description="Show a muted row with per-turn and session token/cost usage plus context-window occupancy. Expand it for the full breakdown."
          />
          <div
            className={
              appearance.turnStatsRow ? "" : "pointer-events-none opacity-50"
            }
          >
            <PreferenceToggle
              checked={
                appearance.turnStatsPerRequest && appearance.turnStatsRow
              }
              onChange={(checked) =>
                saveAppearance({ turnStatsPerRequest: checked })
              }
              label="Provider-run breakdown"
              description="When you expand a turn's stats, also list each completed provider run. A run may contain multiple internal model requests in a tool loop."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Reorderable list of the primary-nav sections, with a live fold marker showing
 * where the current bar width cuts off. Up/down buttons rather than
 * drag-and-drop: the list is short, and buttons work identically on touch and
 * with a keyboard.
 */
function NavOrderControl({
  order,
  sidebarWidth,
  onChange,
}: {
  order: NavSlot[];
  sidebarWidth: number;
  onChange: (next: NavSlot[]) => void;
}) {
  const mobile = useMobileLayout();
  // On mobile the sidebar is a full-screen overlay, so the bar spans the viewport.
  const barWidth = mobile ? viewportWidth() : sidebarWidth;
  // The active section always occupies the label pill, so previewing with the
  // first entry active yields exactly the number of controls the bar shows.
  const visibleCount = planNavSlots({
    width: barWidth,
    sectionIds: order,
    activeId: order[0] ?? "sessions",
  }).visible.length;

  const move = (index: number, delta: number) => {
    const target = index + delta;
    const moved = order[index];
    const displaced = order[target];
    if (!moved || !displaced) return;
    const next = [...order];
    next[index] = displaced;
    next[target] = moved;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {order.map((section, index) => (
        <div key={section} className="flex flex-col gap-1.5">
          {index === visibleCount && index > 0 ? (
            <div className="flex items-center gap-2 py-2 text-micro text-faint">
              <span className="h-px flex-1 bg-line" />
              <span>
                folds into “More” at the current width ({Math.round(barWidth)}
                px)
              </span>
              <span className="h-px flex-1 bg-line" />
            </div>
          ) : null}
          <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted">
              {PRIMARY_NAV_SLOTS[section].icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-caption font-medium text-fg">
              {PRIMARY_NAV_SLOTS[section].label}
            </span>
            <button
              type="button"
              onClick={() => move(index, -1)}
              disabled={index === 0}
              title="Move up"
              aria-label={`Move ${PRIMARY_NAV_SLOTS[section].label} up`}
              className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronUp size={15} />
            </button>
            <button
              type="button"
              onClick={() => move(index, 1)}
              disabled={index === order.length - 1}
              title="Move down"
              aria-label={`Move ${PRIMARY_NAV_SLOTS[section].label} down`}
              className="flex size-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <ChevronDown size={15} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function PreferenceToggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-caption text-fg">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-accent"
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-caption text-muted">
          {description}
        </span>
      </span>
    </label>
  );
}

function PermanentAssistantSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const profile = settings.permanentAssistant;
  const save = (patch: Partial<typeof profile>) =>
    onUpdate({ permanentAssistant: { ...profile, ...patch } });
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Permanent Personal Assistant</h2>
      <p className="mt-1 text-caption text-muted">
        This identity and model power one durable conversation shared by the web
        app and private Slack messages. Messages are processed in arrival order.
      </p>
      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="block text-caption font-medium text-fg">
          Name
          <input
            value={profile.name}
            onChange={(event) => save({ name: event.target.value })}
            maxLength={80}
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-body outline-none focus:border-accent"
          />
        </label>
        <AgentModelFields
          models={models}
          provider={profile.provider}
          modelId={profile.modelId}
          thinkingLevel={profile.thinkingLevel}
          credentialProfileId={profile.credentialProfileId}
          modelLabel="Assistant model"
          onChange={save}
        />
        <label className="block text-caption font-medium text-fg">
          Additional instructions
          <textarea
            value={profile.additionalInstructions}
            onChange={(event) =>
              save({ additionalInstructions: event.target.value })
            }
            rows={7}
            placeholder="Optional preferences, communication style, or durable role instructions…"
            className="mt-1.5 w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 text-body outline-none focus:border-accent"
          />
          <span className="mt-1 block text-caption font-normal text-muted">
            Added to the standard Personal Assistant instructions for both pi
            and Claude SDK. Do not enter credentials or secrets.
          </span>
        </label>
        <p className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-muted">
          Changing the name, provider, model, thinking level, or additional
          instructions starts a new permanent conversation the next time you
          open the Personal Assistant. The previous conversation remains
          available in Sessions.
        </p>
      </div>
    </div>
  );
}

function SessionNamingSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const naming = settings.sessionNaming;

  const save = (patch: Partial<typeof naming>) =>
    onUpdate({ sessionNaming: { ...naming, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Session naming</h2>
      <p className="mt-1 text-caption text-muted">
        After the first prompt, a dedicated no-tool agent asynchronously
        replaces the temporary first-prompt title with a concise session name.
        It only receives that initial user prompt.
      </p>
      <p className="mt-2 text-caption text-muted">
        Recommendation:{" "}
        <span className="text-fg">GitHub Copilot / GPT-4.1</span> with
        <span className="text-fg"> Thinking off</span>. It is non-reasoning,
        fast, and more than capable of producing short titles.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={naming.enabled}
            onChange={(e) => save({ enabled: e.target.checked })}
            className="size-4 accent-accent"
          />
          Automatically name sessions after the first prompt
        </label>

        <AgentModelFields
          models={models}
          provider={naming.provider}
          modelId={naming.modelId}
          thinkingLevel={naming.thinkingLevel}
          credentialProfileId={naming.credentialProfileId}
          modelLabel="Naming model"
          onChange={save}
        />

        {models.length === 0 && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </div>
    </div>
  );
}

function CommitAgentSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const commitAgent = settings.commitAgent;

  const save = (patch: Partial<typeof commitAgent>) =>
    onUpdate({ commitAgent: { ...commitAgent, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Commit agent</h2>
      <p className="mt-1 text-caption text-muted">
        The coding-session <span className="font-mono text-fg">/commit</span>{" "}
        command uses a dedicated no-tool agent to review the diff for safety and
        return a structured commit message decision.
      </p>
      <p className="mt-2 text-caption text-muted">
        Recommendation:{" "}
        <span className="text-fg">GitHub Copilot / GPT-4.1</span> with
        <span className="text-fg"> Thinking off</span>. It is fast and
        sufficient for concise commit messages.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <AgentModelFields
          models={models}
          provider={commitAgent.provider}
          modelId={commitAgent.modelId}
          thinkingLevel={commitAgent.thinkingLevel}
          credentialProfileId={commitAgent.credentialProfileId}
          modelLabel="Commit model"
          onChange={save}
        />

        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          The commit agent returns JSON with either{" "}
          <span className="font-mono">commit</span> or
          <span className="font-mono"> block</span>. The caller blocks unsafe
          commits unless the user explicitly uses
          <span className="font-mono"> --force</span>.
        </div>

        {models.length === 0 && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </div>
    </div>
  );
}

function PrAgentSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const prAgent = settings.prAgent;
  const save = (patch: Partial<typeof prAgent>) =>
    onUpdate({ prAgent: { ...prAgent, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Pull request agent</h2>
      <p className="mt-1 text-caption text-muted">
        The coding-session <span className="font-mono text-fg">/pr</span>{" "}
        command uses a dedicated no-tool agent to draft a structured pull
        request title and body after committing and pushing the branch.
      </p>
      <p className="mt-2 text-caption text-muted">
        By default this uses the same fast model profile as the commit agent.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <AgentModelFields
          models={models}
          provider={prAgent.provider}
          modelId={prAgent.modelId}
          thinkingLevel={prAgent.thinkingLevel}
          credentialProfileId={prAgent.credentialProfileId}
          modelLabel="Pull request model"
          onChange={save}
        />

        {models.length === 0 && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </div>
    </div>
  );
}

function WorktreesSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const worktrees = settings.worktrees;
  const [root, setRoot] = useState(worktrees.root);
  useEffect(() => setRoot(worktrees.root), [worktrees.root]);
  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot);
  useEffect(
    () => setProjectsRoot(settings.projectsRoot),
    [settings.projectsRoot],
  );

  const save = (patch: Partial<typeof worktrees>) =>
    onUpdate({ worktrees: { ...worktrees, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Worktrees</h2>
      <p className="mt-1 text-caption text-muted">
        Worktrees are spawned from a Project's main git checkout as
        <span className="font-mono text-fg"> &lt;folder&gt;-&lt;name&gt;</span>;
        the name is also the branch. A Project can override the root folder on
        its detail page.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <div>
          <label className="mb-1 block text-caption font-medium text-fg">
            Projects root folder
          </label>
          <input
            value={projectsRoot}
            onChange={(event) => setProjectsRoot(event.target.value)}
            onBlur={() => {
              if (
                projectsRoot.trim() &&
                projectsRoot.trim() !== settings.projectsRoot
              )
                onUpdate({ projectsRoot: projectsRoot.trim() });
            }}
            placeholder="~/projects"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-caption text-fg outline-none focus:border-accent"
          />
          <p className="mt-1 text-caption text-faint">
            Projects are cloned into{" "}
            <span className="font-mono">
              &lt;projects root&gt;/&lt;project id&gt;
            </span>
            , which becomes the main checkout.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-caption font-medium text-fg">
            Worktree root folder
          </label>
          <input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            onBlur={() => {
              if (root.trim() && root.trim() !== worktrees.root)
                save({ root: root.trim() });
            }}
            placeholder="~/worktrees"
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-caption text-fg outline-none focus:border-accent"
          />
          <p className="mt-1 text-caption text-faint">
            New worktree folders are created under this directory.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-caption font-medium text-fg">
            Check remotes every N minutes (0 = never)
          </label>
          <input
            type="number"
            min={settingBounds("worktrees.remoteFetchMinutes").min}
            max={settingBounds("worktrees.remoteFetchMinutes").max}
            step={1}
            value={worktrees.remoteFetchMinutes}
            onChange={(event) => {
              const minutes = event.target.valueAsNumber;
              if (!Number.isFinite(minutes)) return;
              save({
                remoteFetchMinutes: Math.min(
                  settingBounds("worktrees.remoteFetchMinutes").max,
                  Math.max(
                    settingBounds("worktrees.remoteFetchMinutes").min,
                    Math.floor(minutes),
                  ),
                ),
              });
            }}
            className="settings-input w-full"
          />
          <p className="mt-1 text-caption text-faint">
            Keeps ahead and behind counts current for repositories you are
            viewing.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-caption font-medium text-fg">
            Default merge strategy
          </label>
          <select
            value={worktrees.defaultMergeStrategy}
            onChange={(event) =>
              save({
                defaultMergeStrategy: event.target
                  .value as typeof worktrees.defaultMergeStrategy,
              })
            }
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-caption text-fg outline-none"
          >
            <option value="squash">
              Squash — one commit on the base branch
            </option>
            <option value="merge">
              Merge commit — keep individual commits
            </option>
            <option value="rebase">
              Rebase + fast-forward — linear history
            </option>
          </select>
        </div>
      </div>

      <div className="mt-4 space-y-5 rounded-xl border border-line bg-panel p-4">
        <p className="text-caption font-medium text-fg">Naming agent</p>
        <p className="-mt-3 text-caption text-faint">
          Proposes worktree/branch names from the task or prompt context (no
          tools; failures fall back to a timestamp name).
        </p>
        <AgentModelFields
          models={models}
          provider={worktrees.namingAgent.provider}
          modelId={worktrees.namingAgent.modelId}
          thinkingLevel={worktrees.namingAgent.thinkingLevel}
          credentialProfileId={worktrees.namingAgent.credentialProfileId}
          modelLabel="Naming model"
          onChange={(patch) =>
            save({ namingAgent: { ...worktrees.namingAgent, ...patch } })
          }
        />
      </div>

      <div className="mt-4 space-y-5 rounded-xl border border-line bg-panel p-4">
        <p className="text-caption font-medium text-fg">Merge agent</p>
        <p className="-mt-3 text-caption text-faint">
          A full Workshop session spawned to resolve merge conflicts (needs
          file/shell tools — pick a capable model).
        </p>
        <AgentModelFields
          models={models}
          provider={worktrees.mergeAgent.provider}
          modelId={worktrees.mergeAgent.modelId}
          thinkingLevel={worktrees.mergeAgent.thinkingLevel}
          credentialProfileId={worktrees.mergeAgent.credentialProfileId}
          modelLabel="Merge model"
          onChange={(patch) =>
            save({ mergeAgent: { ...worktrees.mergeAgent, ...patch } })
          }
        />
      </div>
    </div>
  );
}

function MeetingMinutesScannerSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const scanner = settings.meetingMinutesScanner;

  const save = (patch: Partial<typeof scanner>) =>
    onUpdate({ meetingMinutesScanner: { ...scanner, ...patch } });

  const numberValue = (
    value: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  // Separate model for the calendar's per-day assistant session (day scan + chat).
  const day = settings.calendarDaySession;
  const saveDay = (patch: Partial<typeof day>) =>
    onUpdate({ calendarDaySession: { ...day, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Minutes scanner</h2>
      <p className="mt-1 text-caption text-muted">
        The meeting-minutes scan tool uses a dedicated no-tool sub-agent to turn
        one bounded minutes source into structured action candidates.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <AgentModelFields
          models={models}
          provider={scanner.provider}
          modelId={scanner.modelId}
          thinkingLevel={scanner.thinkingLevel}
          credentialProfileId={scanner.credentialProfileId}
          modelLabel="Scanner model"
          onChange={save}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max source chars">
            <input
              type="number"
              min={settingBounds("meetingMinutesScanner.maxSourceChars").min}
              max={settingBounds("meetingMinutesScanner.maxSourceChars").max}
              value={scanner.maxSourceChars}
              onChange={(e) =>
                save({
                  maxSourceChars: numberValue(
                    e.target.value,
                    scanner.maxSourceChars,
                    settingBounds("meetingMinutesScanner.maxSourceChars").min,
                    settingBounds("meetingMinutesScanner.maxSourceChars").max,
                  ),
                })
              }
              className="settings-input"
            />
          </Field>

          <Field label="Max snippet chars">
            <input
              type="number"
              min={settingBounds("meetingMinutesScanner.maxSnippetChars").min}
              max={settingBounds("meetingMinutesScanner.maxSnippetChars").max}
              value={scanner.maxSnippetChars}
              onChange={(e) =>
                save({
                  maxSnippetChars: numberValue(
                    e.target.value,
                    scanner.maxSnippetChars,
                    settingBounds("meetingMinutesScanner.maxSnippetChars").min,
                    settingBounds("meetingMinutesScanner.maxSnippetChars").max,
                  ),
                })
              }
              className="settings-input"
            />
          </Field>

          <Field label="Timeout ms">
            <input
              type="number"
              min={settingBounds("meetingMinutesScanner.timeoutMs").min}
              max={settingBounds("meetingMinutesScanner.timeoutMs").max}
              value={scanner.timeoutMs}
              onChange={(e) =>
                save({
                  timeoutMs: numberValue(
                    e.target.value,
                    scanner.timeoutMs,
                    settingBounds("meetingMinutesScanner.timeoutMs").min,
                    settingBounds("meetingMinutesScanner.timeoutMs").max,
                  ),
                })
              }
              className="settings-input"
            />
          </Field>
        </div>

        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          The scanner receives only the selected source text/snippets and
          returns strict JSON. It has no tools and cannot search Drive, Gmail,
          Calendar, or create Tasks.
        </div>
      </div>

      <h2 className="mt-8 text-body font-semibold">Calendar day session</h2>
      <p className="mt-1 text-caption text-muted">
        The calendar's per-day chat (the one-click day scan and your follow-up
        questions) runs as a full assistant session using this model. Unlike the
        scanner above, it has the assistant's tools (Calendar, Drive, Gmail,
        Tasks, knowledge).
      </p>
      <div className="mt-4 space-y-5 rounded-xl border border-line bg-panel p-4">
        <AgentModelFields
          models={models}
          provider={day.provider}
          modelId={day.modelId}
          thinkingLevel={day.thinkingLevel}
          credentialProfileId={day.credentialProfileId}
          modelLabel="Day session model"
          onChange={saveDay}
        />
      </div>
    </div>
  );
}

function DayScanSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const dayScan = settings.dayScan;
  const save = (patch: Partial<typeof dayScan>) =>
    onUpdate({ dayScan: { ...dayScan, ...patch } });
  const saveIdentities = (patch: Partial<typeof dayScan.identities>) =>
    save({ identities: { ...dayScan.identities, ...patch } });
  const saveSchedule = (patch: Partial<typeof dayScan.schedule>) =>
    save({ schedule: { ...dayScan.schedule, ...patch } });
  const clampInt = (
    value: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  const identities = dayScan.identities;
  const schedule = dayScan.schedule;
  const identityFields: Array<{
    key: keyof typeof identities;
    label: string;
    placeholder: string;
  }> = [
    {
      key: "googleEmail",
      label: "Google email",
      placeholder: "you@example.com",
    },
    { key: "jiraEmail", label: "Jira email", placeholder: "you@example.com" },
    {
      key: "jiraAccountId",
      label: "Jira account id",
      placeholder: "5b10a2844c…",
    },
    { key: "githubLogin", label: "GitHub login", placeholder: "octocat" },
    {
      key: "tempoAccountId",
      label: "Tempo account id",
      placeholder: "5b10a2844c…",
    },
  ];

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Day scanner</h2>
      <p className="mt-1 text-caption text-muted">
        The deterministic daily scan collects your day's signals (calendar,
        Jira, GitHub, Tempo, tasks, and — where connected — Slack and email)
        into an atomic Knowledge Base commit, then optionally synthesizes an
        attention-first report. These settings govern how "me" is resolved, how
        the report behaves, and when it runs automatically.
      </p>

      <h3 className="mt-6 text-body font-semibold">Identities</h3>
      <p className="mt-1 text-caption text-muted">
        How the scan resolves "me"/"mine" across sources. All optional — an
        unset identity just weakens that source's own-involvement signal, it
        never breaks collection.
      </p>
      <div className="mt-3 grid gap-4 rounded-xl border border-line bg-panel p-4 sm:grid-cols-2">
        {identityFields.map((field) => (
          <Field key={field.key} label={field.label}>
            <input
              type="text"
              value={identities[field.key] ?? ""}
              onChange={(e) =>
                saveIdentities({
                  [field.key]: e.target.value.trim() || undefined,
                } as Partial<typeof identities>)
              }
              placeholder={field.placeholder}
              className="settings-input"
            />
          </Field>
        ))}
      </div>

      <h3 className="mt-8 text-body font-semibold">Report behavior</h3>
      <div className="mt-3 space-y-5 rounded-xl border border-line bg-panel p-4">
        <Field label="Task proposal policy">
          <select
            value={dayScan.taskProposalPolicy}
            onChange={(e) =>
              save({
                taskProposalPolicy: e.target
                  .value as typeof dayScan.taskProposalPolicy,
              })
            }
            className="settings-input"
          >
            <option value="auto">
              Auto — high & medium confidence create Tasks; only low needs
              acceptance
            </option>
            <option value="review">
              Review — every task proposal requires your acceptance
            </option>
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Jira changelog issue cap">
            <input
              type="number"
              min={settingBounds("dayScan.changelogIssueCap").min}
              max={settingBounds("dayScan.changelogIssueCap").max}
              value={dayScan.changelogIssueCap}
              onChange={(e) =>
                save({
                  changelogIssueCap: clampInt(
                    e.target.value,
                    dayScan.changelogIssueCap,
                    settingBounds("dayScan.changelogIssueCap").min,
                    settingBounds("dayScan.changelogIssueCap").max,
                  ),
                })
              }
              className="settings-input"
            />
            <p className="mt-1 text-caption text-faint">
              Max issues selected for changelog fetches per run.
            </p>
          </Field>
          <Field label="Max minutes docs per run">
            <input
              type="number"
              min={settingBounds("dayScan.maxMinutesDocsPerRun").min}
              max={settingBounds("dayScan.maxMinutesDocsPerRun").max}
              value={dayScan.maxMinutesDocsPerRun}
              onChange={(e) =>
                save({
                  maxMinutesDocsPerRun: clampInt(
                    e.target.value,
                    dayScan.maxMinutesDocsPerRun,
                    settingBounds("dayScan.maxMinutesDocsPerRun").min,
                    settingBounds("dayScan.maxMinutesDocsPerRun").max,
                  ),
                })
              }
              className="settings-input"
            />
            <p className="mt-1 text-caption text-faint">
              Minutes documents extracted per run; the rest defer to a later
              run.
            </p>
          </Field>
        </div>
      </div>

      <h3 className="mt-8 text-body font-semibold">Scheduled morning run</h3>
      <p className="mt-1 text-caption text-muted">
        Automatically run a collection each day so the prep view is ready before
        the day starts. It reuses the same pipeline as a manual scan, so a
        scheduled run and a refresh you trigger never conflict.
      </p>
      <div className="mt-3 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={schedule.enabled}
            onChange={(e) => saveSchedule({ enabled: e.target.checked })}
            className="size-4 accent-accent"
          />
          Run a collection automatically each morning
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Time">
            <input
              type="time"
              value={schedule.time}
              disabled={!schedule.enabled}
              onChange={(e) => saveSchedule({ time: e.target.value })}
              className="settings-input disabled:opacity-50"
            />
            <p className="mt-1 text-caption text-faint">
              In your timezone ({settings.profile.effectiveTimeZone}), set under
              Profile.
            </p>
          </Field>
        </div>
        <label
          className={`flex items-center gap-2 text-caption ${schedule.enabled ? "text-fg" : "text-faint"}`}
        >
          <input
            type="checkbox"
            checked={schedule.synthesize}
            disabled={!schedule.enabled}
            onChange={(e) => saveSchedule({ synthesize: e.target.checked })}
            className="size-4 accent-accent"
          />
          Also synthesize the report after collecting
        </label>
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          You can always run or re-run the scan manually from the calendar day
          view; the schedule is just an automatic trigger.
        </div>
      </div>
    </div>
  );
}

function PdfConversionSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const pdf = settings.pdfConversion;
  const save = (patch: Partial<typeof pdf>) =>
    onUpdate({ pdfConversion: { ...pdf, ...patch } });
  // Document blocks are Claude-only, so only Claude SDK models are selectable.
  const claudeModels = models.filter((m) => m.provider === CLAUDE_SDK_PROVIDER);

  const numberValue = (
    value: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">PDF conversion</h2>
      <p className="mt-1 text-caption text-muted">
        The <code>convert_pdf</code> tool converts born-digital PDFs to Markdown
        offline (no model, no settings). When a PDF has no text layer
        (scanned/image), it can fall back to Claude, which transcribes the pages
        as a document block. Only that fallback is configured here.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={pdf.fallbackEnabled}
            onChange={(e) => save({ fallbackEnabled: e.target.checked })}
            className="size-4 accent-accent"
          />
          Enable the Claude fallback for scanned PDFs
        </label>

        <AgentModelFields
          models={claudeModels}
          provider={pdf.provider}
          modelId={pdf.modelId}
          thinkingLevel={pdf.thinkingLevel}
          credentialProfileId={pdf.credentialProfileId}
          modelLabel="Fallback model"
          onChange={save}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timeout ms">
            <input
              type="number"
              min={settingBounds("pdfConversion.timeoutMs").min}
              max={settingBounds("pdfConversion.timeoutMs").max}
              value={pdf.timeoutMs}
              onChange={(e) =>
                save({
                  timeoutMs: numberValue(
                    e.target.value,
                    pdf.timeoutMs,
                    settingBounds("pdfConversion.timeoutMs").min,
                    settingBounds("pdfConversion.timeoutMs").max,
                  ),
                })
              }
              className="settings-input"
            />
          </Field>
        </div>

        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          The fallback is capped at 30 pages to bound cost; larger scanned PDFs
          return their (empty) text layer with a note. Disabling it makes
          scanned PDFs return low-text only, never calling Claude.
        </div>

        {claudeModels.length === 0 && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
            No Claude SDK models are available. Enable the Claude SDK
            integration to configure the fallback.
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Dictation settings. The vocabulary editor is the substantive part: decoder-level
 * hotword biasing is unavailable for the shipped model, so domain jargon is fixed
 * by post-decode rewrites, and those are only useful if you can author them
 * confidently. Hence the live preview — it runs `applySpeechVocabulary`, the SAME
 * function the server applies, so what you see here is what dictation will do.
 */
function DictationSection({
  settings,
  status,
  onUpdate,
}: {
  settings: AppSettings;
  status: SpeechToTextStatus | null;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const speech = settings.speechToText;
  const save = (patch: Partial<typeof speech>) =>
    onUpdate({ speechToText: { ...speech, ...patch } });

  /**
   * Rows live in local draft state, NOT directly on the persisted settings. A
   * freshly added row is empty, and the server's normalizer drops rules with no
   * spoken form — so echoing persisted settings straight back into the list would
   * delete the blank row before it could be typed into, making it impossible to
   * add a rule at all. The draft is what you see and edit; only complete rules
   * are persisted. Initialised once per mount, so an external edit appears on the
   * next visit rather than yanking the row you are typing in.
   */
  const [draft, setDraft] = useState<SpeechVocabularyEntry[]>(
    () => speech.vocabulary,
  );
  // Stable keys so editing the spoken form cannot remount a row mid-keystroke.
  const rowKeysRef = useRef<string[]>(
    speech.vocabulary.map((_, i) => `row-${i}`),
  );
  const keyFor = (index: number) => rowKeysRef.current[index] ?? `row-${index}`;

  const commit = (next: SpeechVocabularyEntry[]) => {
    setDraft(next);
    save({ vocabulary: next.filter((rule) => rule.from.trim().length > 0) });
  };
  const addRule = () => {
    rowKeysRef.current = [
      ...rowKeysRef.current,
      `row-${Date.now()}-${draft.length}`,
    ];
    // No save yet: an empty rule is not persistable, and would be dropped anyway.
    setDraft([...draft, { from: "", to: "" }]);
  };
  const updateRule = (index: number, patch: Partial<SpeechVocabularyEntry>) => {
    commit(
      draft.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    );
  };
  const removeRule = (index: number) => {
    rowKeysRef.current = rowKeysRef.current.filter((_, i) => i !== index);
    commit(draft.filter((_, i) => i !== index));
  };

  const [sample, setSample] = useState("");
  // Preview against the DRAFT so a rule can be tested while it is being typed.
  const preview = applySpeechVocabulary(sample, draft);

  // Read once on mount: the composer is not rendered on this route, so no new
  // dictation can arrive while the section is open.
  const [recent, setRecent] = useState<RecentTranscript[]>(() =>
    recentTranscripts(),
  );
  const sampleRef = useRef<HTMLInputElement>(null);
  const applyAsSample = (text: string) => {
    setSample(text);
    requestAnimationFrame(() =>
      sampleRef.current?.focus({ preventScroll: true }),
    );
  };
  const previewChanged = Boolean(sample.trim()) && preview !== sample;

  const models = status?.availableModelIds ?? [];

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Dictation</h2>
      <p className="mt-1 text-caption text-muted">
        The composer mic button transcribes speech locally on this machine — no
        audio leaves the server, and no external service is involved. Hold the
        button to talk, or tap it to keep recording hands-free; the transcript
        lands in the draft and is never sent for you.
      </p>

      {status && (
        <div
          className={`mt-4 rounded-lg border px-3 py-2 text-caption ${
            status.configured
              ? "border-line bg-surface text-muted"
              : "border-warning/40 bg-warning/10 text-fg"
          }`}
        >
          {status.configured ? (
            <>
              Ready, using <span className="text-fg">{status.modelId}</span>.
              The recognizer starts on first use (about two seconds to load) and
              releases its memory after an idle period.
            </>
          ) : (
            <>
              {status.reason ?? "Dictation is not configured on this server."}
            </>
          )}
        </div>
      )}

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <PreferenceToggle
          checked={speech.enabled}
          onChange={(enabled) => save({ enabled })}
          label="Show the dictation button"
          description="Turn this off to hide the microphone from the composer entirely."
        />

        {models.length > 1 && (
          <div className="space-y-1">
            <label className="text-caption font-medium text-muted">Model</label>
            <select
              value={speech.modelId || models[0]}
              onChange={(e) => save({ modelId: e.target.value })}
              className="settings-input w-full"
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <p className="text-caption text-faint">
              Switching takes effect on the next dictation; the previous model
              is released.
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-caption font-medium">Vocabulary</div>
            <div className="mt-0.5 text-caption text-muted">
              Fix words the recognizer reliably gets wrong — names, products,
              jargon. Each rule rewrites a spoken phrase to its written form
              after transcription. Matching is whole-word and ignores case; the
              written form is inserted exactly as typed.
            </div>
          </div>
          <button
            type="button"
            onClick={addRule}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted hover:bg-surface hover:text-fg"
          >
            <Plus size={12} />
            Add rule
          </button>
        </div>

        {draft.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-3 py-3 text-center text-caption text-faint">
            No rules. Transcripts are used exactly as the model produced them.
          </div>
        ) : (
          <div className="space-y-2">
            {draft.map((rule, index) => (
              <div key={keyFor(index)} className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  {index === 0 && (
                    <label className="text-caption font-medium text-muted">
                      Heard as
                    </label>
                  )}
                  <input
                    type="text"
                    value={rule.from}
                    onChange={(e) =>
                      updateRule(index, { from: e.target.value })
                    }
                    placeholder="forge joe"
                    autoCapitalize="none"
                    className="settings-input w-full"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  {index === 0 && (
                    <label className="text-caption font-medium text-muted">
                      Written as
                    </label>
                  )}
                  <input
                    type="text"
                    value={rule.to}
                    onChange={(e) => updateRule(index, { to: e.target.value })}
                    placeholder="Forgejo"
                    autoCapitalize="none"
                    className="settings-input w-full"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeRule(index)}
                  aria-label="Remove rule"
                  title="Remove rule"
                  className="mb-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-1">
          <label className="text-caption font-medium text-muted">Try it</label>
          <input
            ref={sampleRef}
            type="text"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Paste or dictate a transcript to see your rules applied"
            className="settings-input w-full"
          />
          {sample.trim() ? (
            <div
              className={`rounded-lg border px-3 py-2 text-caption ${
                previewChanged
                  ? "border-accent/40 bg-accent-soft text-fg"
                  : "border-line bg-surface text-faint"
              }`}
            >
              {previewChanged ? preview : "No rule matched this text."}
            </div>
          ) : (
            <p className="text-caption text-faint">
              The preview runs the same rules the server applies, so a rule that
              works here works when you dictate.
            </p>
          )}
        </div>
      </div>

      {recent.length > 0 && (
        <div className="mt-5 rounded-xl border border-line bg-panel p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-caption font-medium">Recent dictations</div>
              <div className="mt-0.5 text-caption text-muted">
                What the recognizer actually wrote, so you can see the wording a
                rule needs to match. Tap one to load it above and check a rule
                against it. Kept in this browser only — the server stores no
                transcripts.
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                clearRecentTranscripts();
                setRecent([]);
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-caption text-muted hover:bg-surface hover:text-fg"
            >
              <Trash2 size={12} />
              Clear
            </button>
          </div>
          <div className="space-y-1.5">
            {recent.map((entry) => (
              <button
                key={`${entry.at}`}
                type="button"
                onClick={() => applyAsSample(entry.text)}
                title="Load into Try it"
                className="flex w-full items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-left text-caption text-fg transition-colors hover:border-accent/40 hover:bg-accent-soft"
              >
                <span className="min-w-0 flex-1 break-words">{entry.text}</span>
                <span className="shrink-0 tabular-nums text-faint">
                  {transcriptAge(entry.at)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Disclosure header="Advanced">
        <div className="space-y-3 p-1">
          <div className="space-y-1">
            <label className="text-caption font-medium text-muted">
              Recognizer threads
            </label>
            <input
              type="number"
              min={settingBounds("speechToText.numThreads").min}
              max={settingBounds("speechToText.numThreads").max}
              value={speech.numThreads}
              onChange={(e) => save({ numThreads: Number(e.target.value) })}
              className="settings-input w-full"
            />
            <p className="text-caption text-faint">
              More threads decode faster up to a point; measured gains flatten
              past 8 on this machine.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-caption font-medium text-muted">
              Release memory after (seconds idle)
            </label>
            <input
              type="number"
              min={settingBounds("speechToText.idleShutdownSeconds").min}
              max={settingBounds("speechToText.idleShutdownSeconds").max}
              value={speech.idleShutdownSeconds}
              onChange={(e) =>
                save({ idleShutdownSeconds: Number(e.target.value) })
              }
              className="settings-input w-full"
            />
            <p className="text-caption text-faint">
              The loaded model holds roughly 2 GB. 0 keeps it resident
              permanently, trading that memory for never paying the load again.
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-caption font-medium text-muted">
              Maximum utterance (seconds)
            </label>
            <input
              type="number"
              min={settingBounds("speechToText.maxUtteranceSeconds").min}
              max={settingBounds("speechToText.maxUtteranceSeconds").max}
              value={speech.maxUtteranceSeconds}
              onChange={(e) =>
                save({ maxUtteranceSeconds: Number(e.target.value) })
              }
              className="settings-input w-full"
            />
            <p className="text-caption text-faint">
              Recording stops automatically at this length.
            </p>
          </div>
        </div>
      </Disclosure>
    </div>
  );
}

function PromptRefinementSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const refinement = settings.promptRefinement;

  const save = (patch: Partial<typeof refinement>) =>
    onUpdate({ promptRefinement: { ...refinement, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Prompt refinement</h2>
      <p className="mt-1 text-caption text-muted">
        The composer refine button uses a dedicated no-tool agent to clean up
        dictated or rough draft prompts before they are sent. It receives the
        draft plus recent visible user/assistant context only; tool calls, tool
        results, and thinking blocks are excluded.
      </p>
      <p className="mt-2 text-caption text-muted">
        Recommendation:{" "}
        <span className="text-fg">GitHub Copilot / GPT-4.1</span> with
        <span className="text-fg"> Thinking off</span> or minimal. The task is
        mostly rewriting and should be fast.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <AgentModelFields
          models={models}
          provider={refinement.provider}
          modelId={refinement.modelId}
          thinkingLevel={refinement.thinkingLevel}
          credentialProfileId={refinement.credentialProfileId}
          modelLabel="Refinement model"
          onChange={save}
        />

        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          The refinement agent is instructed to preserve intent and meaning,
          avoid adding new facts or requirements, and return only the improved
          Markdown prompt.
        </div>

        {models.length === 0 && (
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </div>
    </div>
  );
}

function TaskIntakeAgentSection({
  models,
  projects,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  projects: ProjectRecord[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const agent = settings.taskIntakeAgent;
  const save = (patch: Partial<typeof agent>) =>
    onUpdate({ taskIntakeAgent: { ...agent, ...patch } });
  const selectableProjects = projects
    .filter((project) => project.status !== "archived")
    .sort((a, b) => a.name.localeCompare(b.name));
  const selectedProjectUnavailable =
    Boolean(agent.projectId) &&
    !selectableProjects.some((project) => project.id === agent.projectId);

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Task intake agent</h2>
      <p className="mt-1 text-caption text-muted">
        Slack message shortcuts save a Task first, then this dedicated agent
        turns the Slack context into a concrete action. It can use enabled
        integrations for bounded, read-only research when that makes the Task
        more complete; it cannot change external systems. If context loading,
        research, or curation fails, the saved Task remains marked for retry
        when you use the shortcut again.
      </p>
      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <Field label="Automatic project">
          <select
            value={agent.projectId}
            onChange={(event) => save({ projectId: event.target.value })}
            className="settings-input"
          >
            <option value="">No automatic project</option>
            {selectedProjectUnavailable && (
              <option value={agent.projectId}>
                Unavailable project ({agent.projectId})
              </option>
            )}
            {selectableProjects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} ({project.key})
              </option>
            ))}
          </select>
          <p className="mt-1 text-caption text-faint">
            New Tasks created from the Slack message shortcut are linked to this
            project before the intake agent starts.
          </p>
        </Field>
        <AgentModelFields
          models={models}
          provider={agent.provider}
          modelId={agent.modelId}
          thinkingLevel={agent.thinkingLevel}
          credentialProfileId={agent.credentialProfileId}
          modelLabel="Task intake model"
          onChange={save}
        />
        <Field label="Additional instructions">
          <textarea
            value={agent.additionalInstructions}
            onChange={(e) => save({ additionalInstructions: e.target.value })}
            rows={5}
            maxLength={8000}
            className="settings-input resize-y"
            placeholder="For example: prefer concise technical titles and include unresolved questions."
          />
          <p className="mt-1 text-caption text-faint">
            Optional style or context guidance. It cannot override the fixed
            safety and Task JSON contract.
          </p>
        </Field>
        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          The agent can use a strict read-only subset of your enabled Personal
          Assistant integrations, with a ten-call research budget and no native
          file or shell access. It must return a validated title/description
          JSON object and cannot create, delete, or mutate Tasks or external
          systems.
        </div>
      </div>
    </div>
  );
}

function IntegrationStatusBanner({
  status,
}: {
  status: { ok: boolean; message: string } | null;
}) {
  if (!status) return null;
  return (
    <div
      className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
        status.ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
          : "border-danger/30 bg-danger/10 text-danger"
      }`}
    >
      <div className="flex items-center gap-2 font-medium text-fg">
        {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
        {status.message}
      </div>
    </div>
  );
}

function JiraCard({
  settings,
  status,
  onSaveAndTest,
  onTest,
}: {
  settings: AppSettings;
  status: JiraConnectionStatus | null;
  onSaveAndTest: (patch: JiraSettingsPatch) => void;
  onTest: () => void;
}) {
  const jira = settings.jira;
  const [enabled, setEnabled] = useState(jira.enabled);
  const [atlassianEmail, setAtlassianEmail] = useState(jira.atlassianEmail);
  const [atlassianToken, setAtlassianToken] = useState("");

  useEffect(() => {
    setEnabled(jira.enabled);
    setAtlassianEmail(jira.atlassianEmail);
  }, [jira.enabled, jira.atlassianEmail]);

  // Verify saved credentials once when the page opens so current health shows without a click.
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (checkedOnOpen.current || !jira.atlassianTokenConfigured) return;
    checkedOnOpen.current = true;
    onTest();
  }, [jira.atlassianTokenConfigured, onTest]);

  const saveAndTest = () => {
    onSaveAndTest({
      enabled,
      atlassianEmail,
      ...(atlassianToken.trim()
        ? { atlassianToken: atlassianToken.trim() }
        : {}),
    });
    setAtlassianToken("");
  };

  // Remove the stored token server-side; the settings response flips
  // atlassianTokenConfigured to false, hiding this button and resetting the field.
  const clearToken = () => {
    setAtlassianToken("");
    onSaveAndTest({ enabled, atlassianEmail, clearAtlassianToken: true });
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Jira</h2>
      <p className="mt-1 text-caption text-muted">
        Jira uses your Atlassian email and an API token (Basic auth). The token
        is stored server-side and never sent back to the browser. The Atlassian
        host is set by the deployment.
      </p>
      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable Jira tools for the Assistant agent
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Jira host (configured by deployment)">
            <input
              value={jira.jiraHost}
              placeholder="Not configured (jira.host in app config)"
              disabled
              className="settings-input opacity-60"
            />
          </Field>
          <Field label="Atlassian email">
            <input
              value={atlassianEmail}
              onChange={(e) => setAtlassianEmail(e.target.value)}
              placeholder="you@example.com"
              className="settings-input"
            />
          </Field>
          <SecretField
            label="Atlassian API token"
            configured={jira.atlassianTokenConfigured}
            value={atlassianToken}
            onChange={setAtlassianToken}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and test
          </button>
          {jira.atlassianTokenConfigured && (
            <button
              type="button"
              onClick={clearToken}
              className="settings-button text-danger"
            >
              Clear token
            </button>
          )}
        </div>
      </div>
      <IntegrationStatusBanner status={status} />
    </div>
  );
}

/**
 * Confluence has no credential fields of its own: it authenticates as the Jira
 * integration's Atlassian account. The card therefore states that dependency
 * and links the work to Settings → Jira instead of asking for a second token.
 */
function ConfluenceCard({
  settings,
  status,
  onSaveAndTest,
  onTest,
}: {
  settings: AppSettings;
  status: ConfluenceConnectionStatus | null;
  onSaveAndTest: (patch: ConfluenceSettingsPatch) => void;
  onTest: () => void;
}) {
  const confluence = settings.confluence;
  const [enabled, setEnabled] = useState(confluence.enabled);

  useEffect(() => {
    setEnabled(confluence.enabled);
  }, [confluence.enabled]);

  // Verify the shared credentials once when the page opens so current health
  // shows without a click, the same as the Jira card.
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (checkedOnOpen.current || !confluence.credentialsAvailable) return;
    checkedOnOpen.current = true;
    onTest();
  }, [confluence.credentialsAvailable, onTest]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Confluence</h2>
      <p className="mt-1 text-caption text-muted">
        Confluence is the same Atlassian site as Jira and uses the email and API
        token saved there. The host is set by the deployment.
      </p>
      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable Confluence tools for the Assistant agent
        </label>

        <Field label="Confluence host (configured by deployment)">
          <input
            value={confluence.confluenceHost}
            disabled
            className="settings-input opacity-60"
          />
        </Field>

        {!confluence.credentialsAvailable && (
          <p className="text-caption text-yellow-600 dark:text-yellow-400">
            No Atlassian credentials yet. Enable Jira and save an email and API
            token under Settings → Jira; Confluence shares them.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onSaveAndTest({ enabled })}
            className="settings-button-primary"
          >
            Save and test
          </button>
        </div>
      </div>
      <IntegrationStatusBanner status={status} />
    </div>
  );
}

function TempoCard({
  settings,
  status,
  onUpdate,
  onSaveAndTest,
  onTest,
}: {
  settings: AppSettings;
  status: TempoConnectionStatus | null;
  onUpdate: (patch: TempoSettingsPatch) => void;
  onSaveAndTest: (patch: TempoSettingsPatch) => void;
  onTest: () => void;
}) {
  const tempo = settings.tempo;
  const jira = settings.jira;
  const [enabled, setEnabled] = useState(tempo.enabled);
  const [apiBaseUrl, setApiBaseUrl] = useState(tempo.apiBaseUrl);

  useEffect(() => {
    setEnabled(tempo.enabled);
    setApiBaseUrl(tempo.apiBaseUrl);
  }, [tempo.enabled, tempo.apiBaseUrl]);

  // Verify existing authorization once when the page opens.
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (
      checkedOnOpen.current ||
      !tempo.oauthClientConfigured ||
      !tempo.refreshTokenConfigured
    )
      return;
    checkedOnOpen.current = true;
    onTest();
  }, [tempo.oauthClientConfigured, tempo.refreshTokenConfigured, onTest]);

  const savePreferences = () => onSaveAndTest({ enabled, apiBaseUrl });
  const disconnect = () => {
    setEnabled(false);
    onUpdate({ enabled: false, clearTokens: true });
  };

  // Connect/Reauthorize opens the server OAuth start route in a popup and re-tests once
  // the callback posts completion or the popup closes. Full auto-verify parity is Task-37.
  const connect = () => {
    const origin = serverHttpOrigin();
    const popup = window.open(
      `${origin}/api/tempo/oauth/start`,
      "assistant-tempo-oauth",
      "popup,width=560,height=760",
    );
    let done = false;
    let timer: number | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      onTest();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (
        (event.data as { type?: string } | null)?.type ===
        "assistantTempoOAuthComplete"
      )
        finish();
    };
    window.addEventListener("message", onMessage);
    timer = window.setInterval(() => {
      if (popup?.closed) finish();
    }, 1000);
    if (!popup) window.setTimeout(finish, 800);
  };

  const connected = tempo.refreshTokenConfigured;
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Tempo</h2>
      <p className="mt-1 text-caption text-muted">
        Tempo authorizes via OAuth against your Atlassian site. It also needs
        the Jira integration for worklog issue enrichment and author resolution
        {jira.enabled
          ? ""
          : " — Jira is currently disabled, so worklogs will show raw issue ids only"}
        .
        {tempo.oauthClientConfigured
          ? ""
          : " Tempo OAuth is not configured in app config yet."}
      </p>
      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable Tempo tools for the Assistant agent
        </label>

        <Field label="Tempo API base URL">
          <input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://api.tempo.io/4"
            className="settings-input"
          />
          <span className="mt-1 block text-caption text-muted">
            Moving to another host disconnects Tempo.
          </span>
        </Field>

        <div className="text-caption text-muted">
          {connected
            ? "Connected to Tempo. If authorization stops working, reauthorize below."
            : "Not authorized yet."}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={savePreferences}
            className="settings-button-primary"
          >
            Save preferences
          </button>
          <button
            type="button"
            onClick={connect}
            disabled={!tempo.oauthClientConfigured}
            className="settings-button"
          >
            {connected ? "Reauthorize" : "Connect Tempo"}
          </button>
          {connected && (
            <button
              type="button"
              onClick={disconnect}
              className="settings-button"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>
      <IntegrationStatusBanner status={status} />
    </div>
  );
}

export function GoogleWorkspaceSection({
  settings,
  status,
  onUpdateGoogle,
  onSaveAndTestGoogle,
  onTestGoogle,
}: {
  settings: AppSettings;
  status: GoogleConnectionStatus | null;
  onUpdateGoogle: (patch: GoogleSettingsPatch) => void;
  onSaveAndTestGoogle: (patch: GoogleSettingsPatch) => void;
  onTestGoogle: () => void;
}) {
  const google = settings.google;
  const [enabled, setEnabled] = useState(google.enabled);
  const [gmailMinutesLabelName, setGmailMinutesLabelName] = useState(
    google.gmailMinutesLabelName || "Minutes",
  );
  const [oauthStartedAt, setOauthStartedAt] = useState<number | null>(null);
  const [oauthPhase, setOauthPhase] = useState<"idle" | "opened" | "checking">(
    "idle",
  );
  const oauthWindow = useRef<Window | null>(null);
  const externalOAuth = useRef(false);
  const [oauthOpening, setOauthOpening] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(google.enabled);
    setGmailMinutesLabelName(google.gmailMinutesLabelName || "Minutes");
  }, [google.enabled, google.gmailMinutesLabelName]);

  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (
      checkedOnOpen.current ||
      !google.oauthClientConfigured ||
      !google.refreshTokenConfigured
    )
      return;
    checkedOnOpen.current = true;
    onTestGoogle();
  }, [
    google.oauthClientConfigured,
    google.refreshTokenConfigured,
    onTestGoogle,
  ]);

  useEffect(() => {
    if (oauthStartedAt === null || !status || status.checkedAt < oauthStartedAt)
      return;
    setOauthStartedAt(null);
    setOauthPhase("idle");
    oauthWindow.current = null;
  }, [oauthStartedAt, status]);

  useEffect(() => {
    if (oauthStartedAt === null) return;

    const checkNow = () => {
      oauthWindow.current = null;
      setOauthPhase("checking");
      onTestGoogle();
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== serverHttpOrigin()) return;
      const data = event.data as { type?: string } | null;
      if (data?.type === "assistantGoogleOAuthComplete") checkNow();
    };

    const onFocus = () => {
      if (externalOAuth.current || oauthWindow.current?.closed) checkNow();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onFocus();
    };

    const timer = window.setInterval(() => {
      if (oauthWindow.current?.closed) checkNow();
    }, 1000);

    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [oauthStartedAt, onTestGoogle]);

  const patch = (): GoogleSettingsPatch => ({
    enabled,
    gmailMinutesLabelName: gmailMinutesLabelName.trim() || "Minutes",
  });

  const savePreferences = () => onUpdateGoogle(patch());

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    onUpdateGoogle({ ...patch(), enabled: next });
  };

  const disconnect = () => {
    setEnabled(false);
    setOauthStartedAt(null);
    setOauthPhase("idle");
    oauthWindow.current?.close();
    oauthWindow.current = null;
    onSaveAndTestGoogle({
      enabled: false,
      clearTokens: true,
      gmailMinutesLabelName: gmailMinutesLabelName.trim() || "Minutes",
    });
  };

  const startOAuth = async () => {
    setOauthError(null);
    setOauthOpening(true);
    try {
      const { popup, external } = await startGoogleOAuth();
      oauthWindow.current = popup;
      externalOAuth.current = external;
      setOauthStartedAt(Date.now());
      setOauthPhase("opened");
    } catch (err) {
      setOauthStartedAt(null);
      setOauthPhase("idle");
      setOauthError(err instanceof Error ? err.message : String(err));
    } finally {
      setOauthOpening(false);
    }
  };

  const visibleStatus =
    oauthStartedAt !== null && status && status.checkedAt < oauthStartedAt
      ? null
      : status;
  const connected = google.refreshTokenConfigured;
  const connectedText = connected
    ? google.accountEmail
      ? `Connected as ${google.accountEmail}`
      : "Connected"
    : "Not authorized yet";

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <div className="flex items-center gap-4">
        <div
          className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-white shadow-sm"
          aria-hidden="true"
        >
          <span className="relative block size-8 rounded-full bg-[conic-gradient(#4285f4_0_25%,#34a853_0_42%,#fbbc05_0_67%,#ea4335_0_84%,#4285f4_0)] after:absolute after:inset-[7px] after:rounded-full after:bg-white">
            <span className="absolute right-0 top-[13px] z-10 h-[6px] w-4 bg-[#4285f4]" />
          </span>
        </div>
        <div>
          <h2 className="text-prose font-semibold">Google Workspace</h2>
          <p className="mt-1 text-caption text-muted">
            Connect Google to use Calendar, Gmail, Drive, and Meet with the
            Assistant.
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-5 rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-caption font-medium">Use Google Workspace</div>
            <div className="mt-0.5 text-caption text-faint">
              Allow the Assistant to use your connected account.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable Google Workspace"
            disabled={!connected}
            onClick={toggleEnabled}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? "bg-accent" : "bg-line"}`}
          >
            <span
              className={`absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        <div
          className={`rounded-xl border px-4 py-3 ${connected ? (google.gmailArchiveAuthorized ? "border-emerald-500/30 bg-emerald-500/10" : "border-yellow-500/30 bg-yellow-500/10") : "border-line bg-surface"}`}
        >
          <div className="flex items-center gap-2 text-caption font-medium text-fg">
            {connected && google.gmailArchiveAuthorized ? (
              <CheckCircle2 size={15} className="text-emerald-400" />
            ) : (
              <AlertTriangle
                size={15}
                className={connected ? "text-yellow-500" : "text-faint"}
              />
            )}
            {connectedText}
          </div>
          {!connected ? (
            <div className="mt-1 text-caption text-faint">
              {google.oauthClientConfigured
                ? "Sign in with Google to connect your account."
                : "Google sign-in is not available yet. The app administrator needs to finish the Google setup."}
            </div>
          ) : !google.gmailArchiveAuthorized ? (
            <div className="mt-1 text-caption text-yellow-700 dark:text-yellow-300">
              Email archiving needs updated Google permission. Reauthorize once
              to enable it.
            </div>
          ) : null}
        </div>

        {oauthStartedAt !== null && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-caption text-accent"
          >
            {oauthPhase === "checking" ? (
              <Spinner size="sm" />
            ) : (
              <RefreshCw size={13} />
            )}
            {oauthPhase === "opened"
              ? "Complete Google sign-in in your browser, then return here to refresh the connection."
              : "Checking Google Workspace authorization…"}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => void startOAuth()}
            disabled={!google.oauthClientConfigured || oauthOpening}
            aria-busy={oauthOpening || undefined}
            className={`${connected ? "settings-button" : "settings-button-primary"} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {oauthOpening && <Spinner size="sm" />}
            {connected ? "Reauthorize" : "Sign in with Google"}
          </button>
          {connected && (
            <button
              type="button"
              onClick={disconnect}
              className="settings-button text-danger"
            >
              Sign out
            </button>
          )}
        </div>

        {connected && (
          <details className="border-t border-line pt-4 text-caption">
            <summary className="cursor-pointer text-muted">
              Meeting notes preference
            </summary>
            <Field label="Email label">
              <div className="flex gap-2">
                <input
                  value={gmailMinutesLabelName}
                  onChange={(e) => setGmailMinutesLabelName(e.target.value)}
                  className="settings-input"
                  placeholder="Minutes"
                />
                <button
                  type="button"
                  onClick={savePreferences}
                  className="settings-button"
                >
                  Save
                </button>
              </div>
            </Field>
          </details>
        )}
      </div>

      {oauthError && <ErrorNote message={oauthError} />}
      {visibleStatus && !visibleStatus.ok && (
        <div className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-caption text-danger">
          <div className="mb-2 flex items-center gap-2 font-medium text-fg">
            <XCircle size={15} />
            {visibleStatus.message}
          </div>
          <div className="text-caption opacity-90">
            Try signing in again. If the problem continues, ask the app
            administrator to check the Google setup.
          </div>
        </div>
      )}
    </div>
  );
}

function SlackSection({
  settings,
  status,
  onSaveAndTestSlack,
  onTestSlack,
}: {
  settings: AppSettings;
  status: SlackConnectionStatus | null;
  onSaveAndTestSlack: (patch: SlackSettingsPatch) => void;
  onTestSlack: () => void;
}) {
  const slack = settings.slack;
  const [enabled, setEnabled] = useState(slack.enabled);
  const [oauthStartedAt, setOauthStartedAt] = useState<number | null>(null);
  const oauthWindow = useRef<Window | null>(null);
  const connected = slack.connected;

  useEffect(() => setEnabled(slack.enabled), [slack.enabled]);
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (checkedOnOpen.current || !connected) return;
    checkedOnOpen.current = true;
    onTestSlack();
  }, [connected, onTestSlack]);
  useEffect(() => {
    if (oauthStartedAt === null) return;
    const checkNow = () => {
      oauthWindow.current = null;
      setOauthStartedAt(null);
      onTestSlack();
    };
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin === serverHttpOrigin() &&
        (event.data as { type?: string } | null)?.type ===
          "assistantSlackOAuthComplete"
      )
        checkNow();
    };
    const timer = window.setInterval(() => {
      if (oauthWindow.current?.closed) checkNow();
    }, 1000);
    window.addEventListener("message", onMessage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [oauthStartedAt, onTestSlack]);

  const startOAuth = () => {
    const popup = window.open(
      `${serverHttpOrigin()}/api/slack/oauth/start`,
      "assistant-slack-oauth",
      "popup,width=560,height=760",
    );
    setOauthStartedAt(Date.now());
    oauthWindow.current = popup;
    if (!popup) window.setTimeout(onTestSlack, 1000);
  };
  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    onSaveAndTestSlack({ enabled: next });
  };
  const signOut = () => {
    setEnabled(false);
    onSaveAndTestSlack({
      enabled: false,
      clearUserToken: true,
      clearBotToken: true,
    });
  };
  const checking =
    connected &&
    (!status || (oauthStartedAt !== null && status.checkedAt < oauthStartedAt));
  const healthy = connected && status?.ok === true && !checking;
  const warning = connected && status?.ok === false && !checking;

  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <SlackSettingsHeader
        title="Slack"
        subtitle="Connect Slack to search conversations, read messages, and create Tasks."
      />
      <div className="mt-6 space-y-5 rounded-2xl border border-line bg-panel p-5 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-caption font-medium">Use Slack</div>
            <div className="mt-0.5 text-caption text-faint">
              Allow the Assistant to use your connected Slack account.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Enable Slack"
            disabled={!connected}
            onClick={toggleEnabled}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${enabled ? "bg-accent" : "bg-line"}`}
          >
            <span
              className={`absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>

        <div
          className={`rounded-xl border px-4 py-3 ${healthy ? "border-emerald-500/30 bg-emerald-500/10" : warning ? "border-danger/30 bg-danger/10" : "border-line bg-surface"}`}
        >
          <div className="flex items-center gap-2 text-caption font-medium text-fg">
            {checking ? (
              <Spinner size="md" className="text-faint" />
            ) : healthy ? (
              <CheckCircle2 size={15} className="text-emerald-400" />
            ) : warning ? (
              <AlertTriangle size={15} className="text-danger" />
            ) : (
              <AlertTriangle size={15} className="text-faint" />
            )}
            {checking
              ? "Checking Slack connection…"
              : healthy
                ? "Connected to Slack"
                : warning
                  ? "Slack needs attention"
                  : "Not connected"}
          </div>
          <div className="mt-1 text-caption text-faint">
            {warning
              ? "Sign out and connect Slack again. If the problem continues, ask the app administrator for help."
              : connected
                ? "Your Slack account is connected."
                : "Sign in to connect your Slack account."}
          </div>
        </div>

        {oauthStartedAt !== null && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-caption text-accent"
          >
            <Spinner size="sm" />
            Complete Slack authorization in the opened tab.
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <button
              type="button"
              onClick={startOAuth}
              disabled={!slack.oauthClientConfigured}
              className="settings-button-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              Sign in with Slack
            </button>
          ) : (
            <button
              type="button"
              onClick={signOut}
              className="settings-button text-danger"
            >
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SlackHuddlesSection({
  settings,
  status,
  onSaveAndTestSlack,
  onTestSlack,
}: {
  settings: AppSettings;
  status: SlackHuddleConnectionStatus | null;
  onSaveAndTestSlack: (patch: SlackSettingsPatch) => void;
  onTestSlack: () => void;
}) {
  const slack = settings.slack;
  const [enabled, setEnabled] = useState(slack.huddlesEnabled);
  const [pasteStatus, setPasteStatus] = useState<{
    tone: "ok" | "error";
    message: string;
  } | null>(null);
  useEffect(() => setEnabled(slack.huddlesEnabled), [slack.huddlesEnabled]);
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (
      checkedOnOpen.current ||
      !slack.huddlesEnabled ||
      !slack.clientTokenConfigured ||
      !slack.clientCookieConfigured
    )
      return;
    checkedOnOpen.current = true;
    onTestSlack();
  }, [
    onTestSlack,
    slack.clientCookieConfigured,
    slack.clientTokenConfigured,
    slack.huddlesEnabled,
  ]);
  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!text.trim()) return;
    event.preventDefault();
    const parsed = parseSlackBrowserCurl(text);
    if (parsed.error) {
      setPasteStatus({ tone: "error", message: parsed.error });
      return;
    }
    setPasteStatus({
      tone: "ok",
      message: `Extracted ${parsed.found.join(", ")}; saved and testing now.`,
    });
    onSaveAndTestSlack({ ...parsed.patch, huddlesEnabled: enabled });
  };
  const clear = () => {
    setEnabled(false);
    onSaveAndTestSlack({
      huddlesEnabled: false,
      clearClientToken: true,
      clearClientCookie: true,
    });
  };
  return (
    <div className="mx-auto max-w-xl px-6 py-8">
      <SlackSettingsHeader
        title="Slack Huddles"
        subtitle="Experimental personal Huddle attendance through Slack’s undocumented browser API."
      />
      <div className="mt-6 space-y-5 rounded-2xl border border-amber-500/25 bg-panel p-5 shadow-sm">
        <div className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-caption text-amber-200">
          This capability may break when Slack changes its web client. Browser
          credentials are isolated from normal Slack reads, OAuth, Task intake,
          and bot conversations.
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-caption font-medium">
              Enable experimental Huddle history
            </div>
            <div className="mt-0.5 text-caption text-faint">
              Expose only the dedicated Huddle attendance tool.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-accent" : "bg-line"}`}
          >
            <span
              className={`absolute left-0 top-0.5 size-5 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>
        <div>
          <div className="text-caption font-medium">
            Refresh browser session
          </div>
          <p className="mt-1 text-caption text-faint">
            In Slack DevTools, right-click a{" "}
            <span className="font-mono">huddles.history</span> request, choose{" "}
            <strong>Copy as cURL</strong>, and paste it below.
          </p>
          <input
            type="password"
            value=""
            onPaste={onPaste}
            onChange={() => undefined}
            placeholder="Paste copied huddles.history cURL"
            className="settings-input mt-3 font-mono text-caption"
          />
        </div>
        {pasteStatus && (
          <div
            className={`text-caption ${pasteStatus.tone === "ok" ? "text-emerald-200" : "text-danger"}`}
          >
            {pasteStatus.message}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onSaveAndTestSlack({ huddlesEnabled: enabled })}
            className="settings-button-primary"
          >
            Save and test
          </button>
          <button
            type="button"
            onClick={onTestSlack}
            className="settings-button"
          >
            Test saved session
          </button>
          {(slack.clientTokenConfigured || slack.clientCookieConfigured) && (
            <button
              type="button"
              onClick={clear}
              className="settings-button text-danger"
            >
              Clear browser session
            </button>
          )}
        </div>
      </div>
      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${status.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-danger/30 bg-danger/10 text-danger"}`}
        >
          {status.message}
        </div>
      )}
    </div>
  );
}

function SlackSettingsHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <div
        className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-line bg-white shadow-sm"
        aria-hidden="true"
      >
        <div className="grid size-8 grid-cols-2 gap-0.5 rotate-45 overflow-hidden rounded-lg">
          <span className="bg-[#36c5f0]" />
          <span className="bg-[#2eb67d]" />
          <span className="bg-[#e01e5a]" />
          <span className="bg-[#ecb22e]" />
        </div>
      </div>
      <div>
        <h2 className="text-prose font-semibold">{title}</h2>
        <p className="mt-1 text-caption text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

function Context7Section({
  settings,
  status,
  onSaveAndTestContext7,
  onTestContext7,
}: {
  settings: AppSettings;
  status: Context7ConnectionStatus | null;
  onSaveAndTestContext7: (patch: Context7SettingsPatch) => void;
  onTestContext7: () => void;
}) {
  const context7 = settings.context7;
  const [enabled, setEnabled] = useState(context7.enabled);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setEnabled(context7.enabled);
  }, [context7.enabled]);

  const patch = (): Context7SettingsPatch => ({
    enabled,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const saveAndTest = () => {
    onSaveAndTestContext7(patch());
    setApiKey("");
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Context7</h2>
      <p className="mt-1 text-caption text-muted">
        The <span className="font-mono">context7_resolve_library</span> and{" "}
        <span className="font-mono">context7_get_docs</span> agent tools fetch
        up-to-date library documentation from{" "}
        <a
          href="https://context7.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Context7
        </a>
        . Get a <span className="font-mono">ctx7sk-…</span> key from the
        Context7 dashboard. The key is stored server-side in{" "}
        <span className="font-mono">DATA_DIR/settings/context7.json</span> and
        is never sent back to the browser.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable the Context7 docs-search tools for agents
        </label>

        <SecretField
          label="Context7 API key"
          configured={context7.apiKeyConfigured}
          value={apiKey}
          onChange={setApiKey}
        />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and test
          </button>
          <button
            type="button"
            onClick={onTestContext7}
            className="settings-button"
          >
            Test saved key
          </button>
        </div>
      </div>

      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
            status.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-danger/30 bg-danger/10 text-danger"
          }`}
        >
          <div className="flex items-center gap-2 font-medium text-fg">
            {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {status.message}
          </div>
        </div>
      )}
    </div>
  );
}

function GithubSection({
  settings,
  status,
  onSaveAndTestGithub,
  onTestGithub,
}: {
  settings: AppSettings;
  status: GithubConnectionStatus | null;
  onSaveAndTestGithub: (patch: GithubSettingsPatch) => void;
  onTestGithub: () => void;
}) {
  const github = settings.github;
  const [enabled, setEnabled] = useState(github.enabled);
  const [token, setToken] = useState("");
  const [defaultOwner, setDefaultOwner] = useState(github.defaultOwner);
  const [packageProxyEnabled, setPackageProxyEnabled] = useState(
    github.packageProxyEnabled,
  );

  useEffect(() => {
    setEnabled(github.enabled);
    setDefaultOwner(github.defaultOwner);
    setPackageProxyEnabled(github.packageProxyEnabled);
  }, [github.enabled, github.defaultOwner, github.packageProxyEnabled]);

  const patch = (): GithubSettingsPatch => ({
    enabled,
    defaultOwner: defaultOwner.trim(),
    packageProxyEnabled,
    ...(token.trim() ? { token: token.trim() } : {}),
  });

  const saveAndTest = () => {
    onSaveAndTestGithub(patch());
    setToken("");
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">GitHub</h2>
      <p className="mt-1 text-caption text-muted">
        The GitHub agent tools read from GitHub using a{" "}
        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          classic personal access token
        </a>{" "}
        (scopes <span className="font-mono">repo</span>,{" "}
        <span className="font-mono">read:org</span>,{" "}
        <span className="font-mono">notifications</span>). They enumerate and
        search accessible repositories (including private org repositories),
        search and read code, read issues and pull requests, list notifications,
        and summarize org activity. For a SAML-SSO org, authorize the token for
        that org (Configure SSO) or org calls fail. The token is stored
        server-side in{" "}
        <span className="font-mono">DATA_DIR/settings/github.json</span> and is
        never sent back to the browser.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable the GitHub tools for agents
        </label>

        <SecretField
          label="Personal access token"
          configured={github.tokenConfigured}
          value={token}
          onChange={setToken}
        />

        <div className="space-y-1">
          <label className="text-caption font-medium text-muted">
            Default owner (optional)
          </label>
          <input
            type="text"
            value={defaultOwner}
            onChange={(e) => setDefaultOwner(e.target.value)}
            placeholder="e.g. acme"
            className="settings-input w-full"
          />
        </div>

        <div className="space-y-1">
          <label className="flex items-center gap-2 text-caption text-fg">
            <input
              type="checkbox"
              checked={packageProxyEnabled}
              onChange={(e) => setPackageProxyEnabled(e.target.checked)}
              className="size-4 accent-accent"
            />
            Let builds read private GitHub packages
          </label>
          <p className="text-caption text-muted">
            Runs a local proxy that adds this token to requests for GitHub
            package registries (<span className="font-mono">maven</span>,{" "}
            <span className="font-mono">npm</span>,{" "}
            <span className="font-mono">nuget</span>), so builds in agent
            worktrees can resolve private dependencies without ever holding the
            token. Other hosts are passed through untouched.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and test
          </button>
          <button
            type="button"
            onClick={onTestGithub}
            className="settings-button"
          >
            Test saved token
          </button>
        </div>
      </div>

      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
            status.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-danger/30 bg-danger/10 text-danger"
          }`}
        >
          <div className="flex items-center gap-2 font-medium text-fg">
            {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {status.message}
          </div>
          {status.scopes && status.scopes.length > 0 && (
            <div className="mt-1 text-muted">
              Token scopes:{" "}
              <span className="font-mono">{status.scopes.join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ForgejoSection({
  settings,
  status,
  onSaveAndTestForgejo,
  onTestForgejo,
}: {
  settings: AppSettings;
  status: ForgejoConnectionStatus | null;
  onSaveAndTestForgejo: (patch: ForgejoSettingsPatch) => void;
  onTestForgejo: () => void;
}) {
  const forgejo = settings.forgejo;
  const [enabled, setEnabled] = useState(forgejo.enabled);
  const [baseUrl, setBaseUrl] = useState(forgejo.baseUrl);
  const [token, setToken] = useState("");
  const [defaultOwner, setDefaultOwner] = useState(forgejo.defaultOwner);

  useEffect(() => {
    setEnabled(forgejo.enabled);
    setBaseUrl(forgejo.baseUrl);
    setDefaultOwner(forgejo.defaultOwner);
  }, [forgejo.enabled, forgejo.baseUrl, forgejo.defaultOwner]);

  const patch = (): ForgejoSettingsPatch => ({
    enabled,
    baseUrl: baseUrl.trim(),
    defaultOwner: defaultOwner.trim(),
    ...(token.trim() ? { token: token.trim() } : {}),
  });

  const saveAndTest = () => {
    onSaveAndTestForgejo(patch());
    setToken("");
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Forgejo</h2>
      <p className="mt-1 text-caption text-muted">
        The Forgejo agent tools and worktree pull-request/CI integration talk to
        your self-hosted Forgejo (Gitea-compatible) instance using an{" "}
        <span className="font-mono">access token</span> with repository
        read/write scope. Repositories whose{" "}
        <span className="font-mono">origin</span> remote host matches the base
        URL below resolve to this provider. The base URL is stored server-side;
        the token is stored privately in{" "}
        <span className="font-mono">DATA_DIR/settings/forgejo.json</span> and is
        never sent back to the browser.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable the Forgejo integration
        </label>

        <div className="space-y-1">
          <label className="text-caption font-medium text-muted">
            Instance base URL
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://git.example.com"
            className="settings-input w-full"
          />
          <p className="text-caption text-muted">
            Moving to another host clears the saved token.
          </p>
        </div>

        <SecretField
          label="Access token"
          configured={forgejo.tokenConfigured}
          value={token}
          onChange={setToken}
        />

        <div className="space-y-1">
          <label className="text-caption font-medium text-muted">
            Default owner (optional)
          </label>
          <input
            type="text"
            value={defaultOwner}
            onChange={(e) => setDefaultOwner(e.target.value)}
            placeholder="e.g. my-org"
            className="settings-input w-full"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and test
          </button>
          <button
            type="button"
            onClick={onTestForgejo}
            className="settings-button"
          >
            Test saved settings
          </button>
        </div>
      </div>

      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
            status.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-danger/30 bg-danger/10 text-danger"
          }`}
        >
          <div className="flex items-center gap-2 font-medium text-fg">
            {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {status.message}
          </div>
          {status.version && (
            <div className="mt-1 text-muted">
              Server version:{" "}
              <span className="font-mono">{status.version}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BraveSection({
  settings,
  status,
  onSaveAndTestBrave,
  onTestBrave,
}: {
  settings: AppSettings;
  status: BraveConnectionStatus | null;
  onSaveAndTestBrave: (patch: BraveSettingsPatch) => void;
  onTestBrave: () => void;
}) {
  const brave = settings.brave;
  const [enabled, setEnabled] = useState(brave.enabled);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setEnabled(brave.enabled);
  }, [brave.enabled]);

  const patch = (): BraveSettingsPatch => ({
    enabled,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const saveAndTest = () => {
    onSaveAndTestBrave(patch());
    setApiKey("");
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">Web Search</h2>
      <p className="mt-1 text-caption text-muted">
        The <span className="font-mono">web_search</span> agent tool uses the{" "}
        <a
          href="https://brave.com/search/api/"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Brave Search API
        </a>
        . The key is stored server-side in{" "}
        <span className="font-mono">DATA_DIR/settings/brave.json</span> and is
        never sent back to the browser. The companion{" "}
        <span className="font-mono">web_fetch</span> tool needs no key.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable the web_search tool for agents
        </label>

        <SecretField
          label="Brave Search API key"
          configured={brave.apiKeyConfigured}
          value={apiKey}
          onChange={setApiKey}
        />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and test
          </button>
          <button
            type="button"
            onClick={onTestBrave}
            className="settings-button"
          >
            Test saved key
          </button>
        </div>
      </div>

      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
            status.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-danger/30 bg-danger/10 text-danger"
          }`}
        >
          <div className="flex items-center gap-2 font-medium text-fg">
            {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {status.message}
          </div>
        </div>
      )}
    </div>
  );
}

function OpenAiCompatibleSection({
  settings,
  status,
  onSaveAndTestOpenAiCompatible,
  onTestOpenAiCompatible,
}: {
  settings: AppSettings;
  status: OpenAiCompatibleConnectionStatus | null;
  onSaveAndTestOpenAiCompatible: (patch: OpenAiCompatibleSettingsPatch) => void;
  onTestOpenAiCompatible: () => void;
}) {
  const provider = settings.openAiCompatible;
  const [enabled, setEnabled] = useState(provider.enabled);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [thinkingFormat, setThinkingFormat] = useState(provider.thinkingFormat);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    setEnabled(provider.enabled);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setThinkingFormat(provider.thinkingFormat);
  }, [
    provider.enabled,
    provider.name,
    provider.baseUrl,
    provider.thinkingFormat,
  ]);

  const patch = (): OpenAiCompatibleSettingsPatch => ({
    enabled,
    name,
    baseUrl,
    thinkingFormat,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const saveAndTest = () => {
    onSaveAndTestOpenAiCompatible(patch());
    setApiKey("");
  };

  // Back to a keyless endpoint: the settings response flips apiKeyConfigured
  // to false, hiding this button, and discovery reruns without the header.
  const removeKey = () => {
    setApiKey("");
    onSaveAndTestOpenAiCompatible({
      enabled,
      name,
      baseUrl,
      thinkingFormat,
      clearApiKey: true,
    });
  };

  const models = status?.models ?? provider.models;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-body font-semibold">OpenAI-compatible endpoint</h2>
      <p className="mt-1 text-caption text-muted">
        Add the models of any server that speaks the OpenAI chat completions API
        — a self-hosted llama.cpp, vLLM or Ollama, or a hosted gateway. The
        provider is registered directly with pi at runtime from{" "}
        <span className="font-mono">
          DATA_DIR/settings/openai-compatible.json
        </span>
        , so no
        <span className="font-mono"> ~/.pi/agent/models.json</span> entry is
        needed. The API key is stored server-side and is never sent back to the
        browser.
      </p>

      <div className="mt-6 space-y-5 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center gap-2 text-caption text-fg">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-accent"
          />
          Enable these models in the model picker
        </label>

        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenAI-compatible"
            className="settings-input"
          />
        </Field>

        <Field label="Base URL">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://llm.example.net/v1"
            className="settings-input font-mono text-caption"
          />
          <span className="mt-1 block text-caption text-muted">
            Moving to another host clears the saved API key.
          </span>
        </Field>

        <SecretField
          label="API key (optional)"
          configured={provider.apiKeyConfigured}
          value={apiKey}
          onChange={setApiKey}
        />

        <Field label="Thinking control">
          <select
            value={thinkingFormat}
            onChange={(e) =>
              setThinkingFormat(
                e.target.value as OpenAiCompatibleThinkingFormat,
              )
            }
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-caption text-fg outline-none"
          >
            {OPENAI_COMPATIBLE_THINKING_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format === "none" ? "None — models do not reason" : format}
              </option>
            ))}
          </select>
        </Field>

        <div className="rounded-lg border border-line bg-surface px-3 py-2 text-caption text-faint">
          Save and discover calls <span className="font-mono">/models</span>,
          stores the discovered model metadata in app config, and refreshes the
          live model registry. Thinking control is how the server takes a
          thinking level: with one set, every model offers thinking levels; for
          example <span className="font-mono">qwen-chat-template</span> sends{" "}
          <span className="font-mono">
            chat_template_kwargs.enable_thinking
          </span>
          , as Qwen models on llama.cpp and vLLM expect.
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            type="button"
            onClick={saveAndTest}
            className="settings-button-primary"
          >
            Save and discover models
          </button>
          <button
            type="button"
            onClick={onTestOpenAiCompatible}
            className="settings-button"
          >
            Test saved provider
          </button>
          {provider.apiKeyConfigured && (
            <button
              type="button"
              onClick={removeKey}
              className="settings-button text-danger"
            >
              Remove key
            </button>
          )}
        </div>
      </div>

      {status && (
        <div
          className={`mt-4 rounded-xl border px-4 py-3 text-caption ${
            status.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-danger/30 bg-danger/10 text-danger"
          }`}
        >
          <div className="flex items-center gap-2 font-medium text-fg">
            {status.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
            {status.message}
          </div>
        </div>
      )}

      {models.length > 0 && (
        <div className="mt-4 rounded-xl border border-line bg-panel px-4 py-3">
          <div className="mb-2 text-caption font-semibold text-fg">
            Discovered models
          </div>
          <ul className="space-y-2">
            {models.map((model) => (
              <li
                key={model.id}
                className="rounded-lg border border-line bg-surface px-3 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-caption font-medium text-fg">
                      {model.name}
                    </div>
                    <div className="mt-0.5 text-micro text-faint">
                      {model.input.join("+")} ·{" "}
                      {model.reasoning ? "reasoning" : "non-reasoning"}
                      {model.status ? ` · ${model.status}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-micro text-faint">
                    <div>{model.contextWindow.toLocaleString()} ctx</div>
                    <div>{model.maxTokens.toLocaleString()} max out</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BrowserToolsSettingsSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const browserTools = settings.browserTools;
  const save = (patch: Partial<AppSettings["browserTools"]>) =>
    onUpdate({ browserTools: { ...browserTools, ...patch } });

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h2 className="text-body font-semibold">Browser tools</h2>
      <p className="mt-1 text-caption text-muted">
        Workshop/Developer sessions can use curated Playwright MCP browser tools
        for local UI verification — an ordinary tool group like Jira or Slack,
        discovered on demand rather than requiring a separate enable step.
      </p>
      <div className="mt-6 space-y-4">
        <section className="rounded-xl border border-line bg-panel p-4">
          <h3 className="text-body font-semibold text-fg">Browser testing</h3>
          <p className="mt-1 text-caption text-muted">
            Curated Playwright MCP tools (navigate, snapshot, click, fill,
            screenshot, console, network). Screenshots/traces are stored as
            session artifacts, not in the repo.
          </p>
          <label className="mt-4 flex items-center gap-2 text-caption text-fg">
            <input
              type="checkbox"
              checked={browserTools.headed}
              onChange={(e) => save({ headed: e.target.checked })}
              className="size-4 accent-accent"
            />
            Launch browser in headed/debug mode instead of headless
          </label>
        </section>
        <section className="rounded-xl border border-line bg-panel p-4">
          <h3 className="text-body font-semibold text-fg">Raw browser MCP</h3>
          <p className="mt-1 text-caption text-muted">
            Advanced escape hatch for direct Playwright MCP tool calls by name,
            for capabilities missing from the standard browser tools. Off by
            default.
          </p>
          <label className="mt-4 flex items-center gap-2 text-caption text-fg">
            <input
              type="checkbox"
              checked={browserTools.rawMcpEnabled}
              onChange={(e) => save({ rawMcpEnabled: e.target.checked })}
              className="size-4 accent-accent"
            />
            Enable raw browser MCP
          </label>
        </section>
      </div>
    </div>
  );
}

export type SlackBrowserCurlParseResult =
  | { patch: SlackSettingsPatch; found: string[]; error?: undefined }
  | { patch: SlackSettingsPatch; found: string[]; error: string };

export function parseSlackBrowserCurl(
  text: string,
): SlackBrowserCurlParseResult {
  const patch: SlackSettingsPatch = {};
  const found: string[] = [];
  const requestUrl = firstSlackApiUrl(text);
  if (!requestUrl || requestUrl.pathname !== "/api/huddles.history") {
    return {
      patch,
      found,
      error:
        "This is not a copied Slack huddles.history request. In Slack DevTools, copy a huddles.history request as cURL.",
    };
  }

  for (const header of copiedCurlHeaders(text)) {
    const separator = header.indexOf(":");
    if (separator === -1) continue;
    const name = header.slice(0, separator).trim().toLowerCase();
    const value = header.slice(separator + 1).trim();
    if (name === "authorization") {
      const match = value.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) {
        patch.clientToken = match[1].trim();
        found.push("browser token");
      }
    } else if (name === "cookie") {
      applyCopiedCookie(value, patch, found);
    }
  }

  if (!patch.clientToken) {
    const formToken = copiedCurlFormField(text, "token");
    if (formToken) {
      patch.clientToken = formToken;
      found.push("browser token");
    }
  }
  if (!patch.clientToken) {
    const tokenMatch =
      text.match(/authorization:\s*Bearer\s+([^'"\s\\]+)/i) ??
      text.match(/name="token"\s*\r?\n\r?\n([^\r\n]+)/i);
    if (tokenMatch?.[1]) {
      patch.clientToken = tokenMatch[1].trim();
      found.push("browser token");
    }
  }
  if (!patch.clientCookieD) {
    const curlCookie = copiedCurlCookie(text);
    if (curlCookie) applyCopiedCookie(curlCookie, patch, found);
  }
  if (!patch.clientCookieD) {
    const cookieMatch = text.match(/cookie:\s*([^'"\n\\]+)/i);
    if (cookieMatch?.[1])
      applyCopiedCookie(cookieMatch[1].trim(), patch, found);
  }

  const uniqueFound = [...new Set(found)];
  if (!patch.clientToken || !patch.clientCookieD) {
    return {
      patch,
      found: uniqueFound,
      error:
        "Could not find both a Slack browser token and cookies. Copy a Slack web API request as cURL (including --data-raw token and -b/--cookie cookies) and paste it here.",
    };
  }
  return { patch, found: uniqueFound };
}

function firstSlackApiUrl(text: string): URL | null {
  const matches = text.match(/https:\/\/[^\s'"\\]+/g) ?? [];
  for (const raw of matches) {
    try {
      const url = new URL(raw);
      if (
        url.hostname.endsWith("slack.com") &&
        url.pathname.startsWith("/api/")
      )
        return url;
    } catch {
      // Ignore non-URL fragments in copied shell commands.
    }
  }
  return null;
}

function copiedCurlHeaders(text: string): string[] {
  const headers: string[] = [];
  const quotedHeaderRe = /(?:-H|--header)\s+(['"])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = quotedHeaderRe.exec(text)) !== null) {
    if (match[2]) headers.push(match[2]);
  }
  return headers;
}

function copiedCurlCookie(text: string): string | null {
  const match = text.match(/(?:\s|^)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/);
  return match?.[2]?.trim() || null;
}

function copiedCurlFormField(text: string, name: string): string | null {
  const normalized = text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `name="${escapedName}"\\r?\\n\\r?\\n([^\\r\\n]+)`,
    "i",
  );
  return normalized.match(regex)?.[1]?.trim() || null;
}

function applyCopiedCookie(
  value: string,
  patch: SlackSettingsPatch,
  found: string[],
): void {
  const dCookie = value.match(/(?:^|;\s*)d=([^;]+)/)?.[1];
  if (dCookie) {
    patch.clientCookieD = dCookie;
    found.push("d cookie");
  }
}

const TEXT_SCALE_OPTIONS: readonly TextScale[] = [100, 110, 120, 130];

function TextSizeControl({
  value,
  onChange,
}: {
  value: TextScale;
  onChange: (value: TextScale) => void;
}) {
  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label="Text size"
        className="inline-flex rounded-lg border border-line bg-surface p-0.5"
      >
        {TEXT_SCALE_OPTIONS.map((option) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option)}
              className={`rounded-md px-3 py-1.5 text-caption font-medium transition-colors ${
                selected
                  ? "bg-accent text-accent-fg"
                  : "text-muted hover:text-fg"
              }`}
            >
              {option}%
            </button>
          );
        })}
      </div>
      {/* Live preview: because the selected scale is applied to the document
          root immediately, this sample reflows at the chosen size right away. */}
      <div className="rounded-lg border border-line bg-surface p-3">
        <p className="text-title font-semibold text-fg">The quick brown fox</p>
        <p className="mt-1 text-body text-fg">
          Sample interface text jumps over the lazy dog at your selected size.
        </p>
        <p className="mt-1 text-caption text-muted">
          Secondary metadata stays legible.
        </p>
        <p className="mt-2 font-mono text-caption text-muted">
          const scale = {value};
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-medium uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  );
}

function SecretField({
  label,
  configured,
  value,
  onChange,
}: {
  label: string;
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <div className="relative">
        <KeyRound
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            configured ? "Configured — leave blank to keep" : "Paste token"
          }
          className="settings-input !pl-8"
        />
      </div>
    </Field>
  );
}

export function ModelsSection({
  models,
  settings,
  onUpdate,
  onRefresh,
  refreshing,
}: {
  models: ModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const visible = visibleModels(models, settings);
  const hiddenSet = new Set(settings.models.hidden);
  const hidden = models.filter((m) => hiddenSet.has(modelKey(m)));

  // Local working copy so the list reorders live while dragging. It's resynced
  // whenever the persisted order changes — including a failed save, which leaves
  // the stored order untouched and snaps the list back.
  const signature = visible.map(modelKey).join("\n");
  const [items, setItems] = useState<ModelOption[]>(visible);
  // `signature` captures the persisted order's CONTENT; `visible` is rebuilt
  // every render, so it is read through a ref rather than depended on —
  // depending on it would snap the list back out from under a drag in progress.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    setItems(visibleRef.current);
  }, [signature]);

  // Persist a new arrangement. `order` is kept as the exact visible order so
  // models the registry adds later appear at the end until arranged.
  const save = (visibleList: ModelOption[], hiddenKeys: string[]) =>
    onUpdate({
      models: { order: visibleList.map(modelKey), hidden: hiddenKeys },
    });

  // A reorder has no visible confirmation beyond the rows moving, which a
  // screen reader never sees: this says where the model landed.
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const { listRef, draggingKey, handleProps } = usePointerReorder({
    items,
    keyOf: modelKey,
    onReorder: setItems,
    onCommit: (next, moved) => {
      save(next, settings.models.hidden);
      setMoveAnnouncement(
        `${moved.name} moved to position ${next.indexOf(moved) + 1} of ${next.length}`,
      );
    },
  });

  const hide = (key: string) =>
    save(
      items.filter((m) => modelKey(m) !== key),
      [...settings.models.hidden, key],
    );

  const show = (key: string) => {
    const model = models.find((m) => modelKey(m) === key);
    if (!model) return;
    save(
      [...items, model],
      settings.models.hidden.filter((k) => k !== key),
    );
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-body font-semibold">Models</h2>
        {/*
          The busy state is the whole point of this control: a refresh that
          changed nothing returns a list identical to the one on screen, so
          without a spinner a working button and a dead one look the same.
        */}
        <Button
          variant="secondary"
          size="sm"
          busy={refreshing}
          onClick={onRefresh}
          className="gap-1.5 rounded-lg px-2.5 text-caption text-muted"
          title="Fetch provider model definitions again"
        >
          {refreshing ? null : <RefreshCw size={13} />}
          Refresh
        </Button>
      </div>
      <p className="mt-1 text-caption text-muted">
        Drag a row by its grip to reorder — models appear in the picker
        top-to-bottom in this order. Hidden models stay usable if already
        selected; they just drop out of the list. Refresh fetches the model
        definitions again for every enabled provider and account, even if they
        were checked recently — a model released today shows up here as soon as
        the provider lists it. Account-specific availability follows the
        credential profile selected for a new session.
      </p>

      {models.length === 0 && (
        <div className="mt-6 rounded-lg border border-line bg-panel px-4 py-6 text-center text-caption text-faint">
          No models available. Enable and configure a provider first.
        </div>
      )}

      {items.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-micro font-semibold uppercase tracking-wide text-faint">
            Visible · {items.length}
          </div>
          <p aria-live="polite" className="sr-only">
            {moveAnnouncement}
          </p>
          <ul ref={listRef} className="flex flex-col gap-1">
            {items.map((m, i) => {
              const key = modelKey(m);
              return (
                <li
                  key={key}
                  className={`flex select-none items-center gap-2 rounded-lg border bg-panel px-3 py-2 transition-colors ${
                    draggingKey === key
                      ? "border-accent/50 shadow-sm"
                      : "border-line hover:border-line-strong"
                  }`}
                >
                  {/*
                    The grip is the only drag surface, and a real button: a
                    whole row taking the gesture would swallow the list's own
                    scroll on touch, and the arrow keys reorder without one.
                  */}
                  <button
                    type="button"
                    aria-label={`Reorder ${m.name} (${m.provider}), position ${i + 1} of ${items.length} — drag, or use the arrow keys`}
                    className={`-ml-1 shrink-0 cursor-grab rounded-md p-1 text-faint transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      draggingKey === key ? "cursor-grabbing text-fg" : ""
                    }`}
                    {...handleProps(i)}
                  >
                    <GripVertical size={15} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-caption text-fg">
                      <span className="truncate">{m.name}</span>
                      {m.reasoning && (
                        <Brain size={11} className="shrink-0 text-faint" />
                      )}
                    </div>
                    <div className="text-micro text-faint">{m.provider}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => hide(key)}
                    title="Hide model"
                    className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
                  >
                    <Eye size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {hidden.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-micro font-semibold uppercase tracking-wide text-faint">
            Hidden · {hidden.length}
          </div>
          <ul className="flex flex-col gap-1">
            {hidden.map((m) => (
              <li
                key={modelKey(m)}
                className="flex items-center gap-2 rounded-lg border border-line bg-panel/50 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-caption text-muted">
                    {m.name}
                  </div>
                  <div className="text-micro text-faint">{m.provider}</div>
                </div>
                <button
                  type="button"
                  onClick={() => show(modelKey(m))}
                  title="Show model"
                  className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-fg"
                >
                  <EyeOff size={15} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
