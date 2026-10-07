import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field as UiField,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "./common/IconButton.tsx";
import { Item, ItemContent } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import { EmptyBox, ErrorNote, Spinner } from "./common/load.tsx";
import { Button } from "@/components/ui/button";
import { useDialogs } from "./common/dialogs.tsx";
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
type SectionProps = Pick<Props, "settings" | "onUpdate">;
type AgentSectionProps = SectionProps & { models: AccountModelOption[] };

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
      <div className="flex h-full w-full flex-col bg-background text-foreground">
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
          {section === "knowledge-base" && (
            <KnowledgeBaseSection settings={settings} onUpdate={onUpdate} />
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
            <EmptyBox>
              Pick a settings section in the Settings browser.
            </EmptyBox>
          )}
        </div>
      </div>
    </CredentialProfilesContext.Provider>
  );
}

function ClaudeSdkSection({ settings, onUpdate }: SectionProps) {
  const sdk = settings.claudeSdk;
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Claude SDK</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Enable Claude via the Agent SDK — an in-process Claude agent driven
        through the normal chat composer: prompts, model, and thinking level are
        sent straight to the SDK session with full tool access.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Authentication uses the isolated Claude profiles configured below.
        Follow a profile's setup command to sign in with the intended account.
        Model, thinking level, and profile lock after the session's first turn.
      </p>

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable Claude SDK sessions"
          checked={sdk.enabled}
          onChange={(enabled) => onUpdate({ claudeSdk: { ...sdk, enabled } })}
        />
        <p className="text-sm text-muted-foreground">
          When enabled, a new Claude SDK session can be started from the sidebar
          and appears in the Sessions list alongside Assistant and Workshop
          sessions.
        </p>
      </SettingsCard>
    </div>
  );
}

function OpenAiSection() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">OpenAI</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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
    <SettingsCard>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {profile.name}
          </p>
          <Badge
            variant={
              !profile.enabled
                ? "secondary"
                : profile.status === "ready"
                  ? "success"
                  : profile.status === "error"
                    ? "destructive"
                    : "warning"
            }
          >
            {providerLabel} · {profile.enabled ? profile.status : "disabled"}
          </Badge>
        </div>
        {onRename || onDelete ? (
          <div className="flex shrink-0 items-center gap-0.5">
            {onRename ? (
              <IconButton
                label={`Rename ${profile.name}`}
                onClick={onRename}
                title="Rename profile"
              >
                <Pencil />
              </IconButton>
            ) : null}
            {onDelete ? (
              <IconButton
                label={`Delete ${profile.name}`}
                onClick={onDelete}
                title="Delete profile"
              >
                <Trash2 />
              </IconButton>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <Switch
          checked={profile.enabled}
          aria-label={`${profile.enabled ? "Disable" : "Enable"} ${profile.name}`}
          onCheckedChange={onToggle}
        />
        <Button
          variant="outline"
          disabled={connectionDisabled}
          onClick={onConnect}
        >
          {profile.status === "connecting" ? (
            <Spinner size="sm" />
          ) : (
            <RefreshCw />
          )}
          <span className="truncate">{connectionLabel}</span>
        </Button>
      </div>
      {profile.setup ? (
        <Item variant="muted" className="mt-2">
          <ItemContent>
            <p>{profile.setup.detail}</p>
            {profile.setup.verificationUri ? (
              <a
                href={profile.setup.verificationUri}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-primary underline"
              >
                {profile.setup.verificationUri}
              </a>
            ) : null}
            {profile.setup.userCode ? (
              <p className="mt-1 font-mono text-foreground">
                Code: {profile.setup.userCode}
              </p>
            ) : null}
            {profile.setup.command ? (
              <code className="mt-2 block break-all text-foreground">
                {profile.setup.command}
              </code>
            ) : null}
          </ItemContent>
        </Item>
      ) : null}
      {profile.error ? (
        <ErrorNote className="mt-2" message={profile.error} />
      ) : null}
      <CredentialProfileUsageBlock
        profile={profile}
        onOpenSection={onOpenSection}
      />
    </SettingsCard>
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
    <Item variant="muted" className="mt-2">
      <ItemContent>
        <p className="font-medium text-foreground">Used by</p>
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
            {boundSessionCount === 1 ? "session" : "sessions"} — they keep
            running on it even when disabled
          </p>
        ) : null}
        {pinnedSlots.length > 0 ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span>Pinned by:</span>
            {pinnedSlots.map((slot) => (
              <Button
                key={slot.key}
                variant="outline"
                size="xs"
                onClick={() => onOpenSection?.(slot.section as SectionId)}
              >
                {slot.label}
              </Button>
            ))}
          </div>
        ) : null}
      </ItemContent>
    </Item>
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
        <SettingsCard>
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">
                {providerLabel} profiles
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Profiles are isolated under PA data. Tokens never enter the
                browser or app settings.
              </p>
            </div>
            <IconButton
              label={`Refresh ${providerLabel} profiles`}
              onClick={() => void refresh()}
              title={`Refresh ${providerLabel} profiles`}
            >
              <RefreshCw />
            </IconButton>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={`${providerLabel} profile name`}
              className="flex-1"
            />
            <Button onClick={() => void add()} disabled={!name.trim()}>
              Add {providerLabel} profile
            </Button>
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
        </SettingsCard>
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

function ProfileSection({ settings, onUpdate }: SectionProps) {
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
      <h2 className="text-sm font-semibold">Profile</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Who the assistant works for. The timezone decides what
        &ldquo;today&rdquo; means everywhere: Task planning, memory reminders,
        and the local times tools report.
      </p>

      <SettingsCard className="mt-6">
        <Field label="Name">
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => {
              if (displayName.trim() !== profile.displayName)
                save({ displayName: displayName.trim() });
            }}
            placeholder="Your name"
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Used to name you on your new comments. Left empty, you are
            &ldquo;the user&rdquo; and comments read &ldquo;You&rdquo;.
          </p>
        </Field>
        <Field label="Timezone">
          <Input
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
          />
          {zoneValid ? (
            <p className="mt-1 text-sm text-muted-foreground">
              An IANA timezone such as America/New_York. Leave it empty to
              follow the server. In effect: {profile.effectiveTimeZone}.
            </p>
          ) : (
            <FieldError>
              Not a valid IANA timezone; it is not saved until corrected.
            </FieldError>
          )}
        </Field>
      </SettingsCard>
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
      <h2 className="text-lg font-semibold">Appearance</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Adjust local interface preferences for this browser.
      </p>

      <SettingsCard className="mt-6">
        <h3 className="text-sm font-semibold text-foreground">Theme</h3>
        <p className="text-sm text-muted-foreground">
          The color theme for this browser. On a wide layout the header's
          sun/moon button flips the same preference; a phone has no app header,
          so this is the only place.
        </p>
        <Field label="Theme">
          <NativeSelect
            value={prefs.theme}
            onChange={(e) =>
              onUpdate({ theme: e.target.value as Prefs["theme"] })
            }
            className="w-full"
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </NativeSelect>
        </Field>
      </SettingsCard>

      <SettingsCard className="mt-5">
        <h3 className="text-sm font-semibold text-foreground">Text size</h3>
        <p className="text-sm text-muted-foreground">
          Scale the interface typography for this browser only. Larger sizes
          affect text alone — panel widths, spacing, and icons stay the same.
          Saved locally and applied instantly.
        </p>
        <TextSizeControl
          value={prefs.textScale}
          onChange={(textScale) => onUpdate({ textScale })}
        />
      </SettingsCard>

      <SettingsCard className="mt-5">
        <h3 className="text-sm font-semibold text-foreground">
          Navigation bar order
        </h3>
        <p className="text-sm text-muted-foreground">
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
      </SettingsCard>

      <SettingsCard className="mt-5">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">
            Panel animations
          </h3>
          <p className="text-sm text-muted-foreground">
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
      </SettingsCard>

      <SettingsCard className="mt-5">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">
            Chat transcript
          </h3>
          <p className="text-sm text-muted-foreground">
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
      </SettingsCard>
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
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Separator className="flex-1" />
              <span>
                folds into “More” at the current width ({Math.round(barWidth)}
                px)
              </span>
              <Separator className="flex-1" />
            </div>
          ) : null}
          <Item variant="outline">
            <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
              {PRIMARY_NAV_SLOTS[section].icon}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {PRIMARY_NAV_SLOTS[section].label}
            </span>
            <IconButton
              label={`Move ${PRIMARY_NAV_SLOTS[section].label} up`}
              title="Move up"
              onClick={() => move(index, -1)}
              disabled={index === 0}
            >
              <ChevronUp />
            </IconButton>
            <IconButton
              label={`Move ${PRIMARY_NAV_SLOTS[section].label} down`}
              title="Move down"
              onClick={() => move(index, 1)}
              disabled={index === order.length - 1}
            >
              <ChevronDown />
            </IconButton>
          </Item>
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
  ariaLabel,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <UiField orientation="horizontal">
      <FieldContent>
        {ariaLabel ? (
          <FieldTitle>{label}</FieldTitle>
        ) : (
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
        )}
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label={ariaLabel}
        disabled={disabled}
      />
    </UiField>
  );
}

function PermanentAssistantSection({
  models,
  settings,
  onUpdate,
}: AgentSectionProps) {
  const profile = settings.permanentAssistant;
  const save = (patch: Partial<typeof profile>) =>
    onUpdate({ permanentAssistant: { ...profile, ...patch } });
  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Permanent Personal Assistant</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        This identity and model power one durable conversation shared by the web
        app and private Slack messages. Messages are processed in arrival order.
      </p>
      <SettingsCard className="mt-6">
        <Field label="Name">
          <Input
            value={profile.name}
            onChange={(event) => save({ name: event.target.value })}
            maxLength={80}
          />
        </Field>
        <AgentModelFields
          models={models}
          provider={profile.provider}
          modelId={profile.modelId}
          thinkingLevel={profile.thinkingLevel}
          credentialProfileId={profile.credentialProfileId}
          modelLabel="Assistant model"
          onChange={save}
        />
        <Field label="Additional instructions">
          <Textarea
            value={profile.additionalInstructions}
            onChange={(event) =>
              save({ additionalInstructions: event.target.value })
            }
            rows={7}
            placeholder="Optional preferences, communication style, or durable role instructions…"
          />
          <FieldDescription>
            Added to the standard Personal Assistant instructions for both pi
            and Claude SDK. Do not enter credentials or secrets.
          </FieldDescription>
        </Field>
        <FieldDescription>
          Changing the name, provider, model, thinking level, or additional
          instructions starts a new permanent conversation the next time you
          open the Personal Assistant. The previous conversation remains
          available in Sessions.
        </FieldDescription>
      </SettingsCard>
    </div>
  );
}

function SessionNamingSection({
  models,
  settings,
  onUpdate,
}: AgentSectionProps) {
  const naming = settings.sessionNaming;

  const save = (patch: Partial<typeof naming>) =>
    onUpdate({ sessionNaming: { ...naming, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Session naming</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        After the first prompt, a dedicated no-tool agent asynchronously
        replaces the temporary first-prompt title with a concise session name.
        It only receives that initial user prompt.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Recommendation:{" "}
        <span className="text-foreground">GitHub Copilot / GPT-4.1</span> with
        <span className="text-foreground"> Thinking off</span>. It is
        non-reasoning, fast, and more than capable of producing short titles.
      </p>

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Automatically name sessions after the first prompt"
          checked={naming.enabled}
          onChange={(enabled) => save({ enabled })}
        />

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
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function CommitAgentSection({ models, settings, onUpdate }: AgentSectionProps) {
  const commitAgent = settings.commitAgent;

  const save = (patch: Partial<typeof commitAgent>) =>
    onUpdate({ commitAgent: { ...commitAgent, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Commit agent</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The coding-session{" "}
        <span className="font-mono text-foreground">/commit</span> command uses
        a dedicated no-tool agent to review the diff for safety and return a
        structured commit message decision.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Recommendation:{" "}
        <span className="text-foreground">GitHub Copilot / GPT-4.1</span> with
        <span className="text-foreground"> Thinking off</span>. It is fast and
        sufficient for concise commit messages.
      </p>

      <SettingsCard className="mt-6">
        <AgentModelFields
          models={models}
          provider={commitAgent.provider}
          modelId={commitAgent.modelId}
          thinkingLevel={commitAgent.thinkingLevel}
          credentialProfileId={commitAgent.credentialProfileId}
          modelLabel="Commit model"
          onChange={save}
        />

        <FieldDescription>
          The commit agent returns JSON with either{" "}
          <span className="font-mono">commit</span> or{" "}
          <span className="font-mono">block</span>. The caller blocks unsafe
          commits unless the user explicitly uses{" "}
          <span className="font-mono">--force</span>.
        </FieldDescription>

        {models.length === 0 && (
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function PrAgentSection({ models, settings, onUpdate }: AgentSectionProps) {
  const prAgent = settings.prAgent;
  const save = (patch: Partial<typeof prAgent>) =>
    onUpdate({ prAgent: { ...prAgent, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Pull request agent</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The coding-session{" "}
        <span className="font-mono text-foreground">/pr</span> command uses a
        dedicated no-tool agent to draft a structured pull request title and
        body after committing and pushing the branch.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        By default this uses the same fast model profile as the commit agent.
      </p>

      <SettingsCard className="mt-6">
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
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function WorktreesSection({ models, settings, onUpdate }: AgentSectionProps) {
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
      <h2 className="text-sm font-semibold">Worktrees</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Worktrees are spawned from a Project's main git checkout as
        <span className="font-mono text-foreground">
          {" "}
          &lt;folder&gt;-&lt;name&gt;
        </span>
        ; the name is also the branch. A Project can override the root folder on
        its detail page.
      </p>

      <SettingsCard className="mt-6">
        <Field label="Projects root folder">
          <Input
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
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Projects are cloned into{" "}
            <span className="font-mono">
              &lt;projects root&gt;/&lt;project id&gt;
            </span>
            , which becomes the main checkout.
          </p>
        </Field>

        <Field label="Worktree root folder">
          <Input
            value={root}
            onChange={(event) => setRoot(event.target.value)}
            onBlur={() => {
              if (root.trim() && root.trim() !== worktrees.root)
                save({ root: root.trim() });
            }}
            placeholder="~/worktrees"
          />
          <p className="mt-1 text-sm text-muted-foreground">
            New worktree folders are created under this directory.
          </p>
        </Field>

        <Field label="Check remotes every N minutes (0 = never)">
          <Input
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
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Keeps ahead and behind counts current for repositories you are
            viewing.
          </p>
        </Field>

        <Field label="Default merge strategy">
          <NativeSelect
            value={worktrees.defaultMergeStrategy}
            onChange={(event) =>
              save({
                defaultMergeStrategy: event.target
                  .value as typeof worktrees.defaultMergeStrategy,
              })
            }
            className="w-full"
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
          </NativeSelect>
        </Field>
      </SettingsCard>

      <SettingsCard className="mt-4">
        <p className="text-sm font-medium text-foreground">Naming agent</p>
        <p className="-mt-3 text-sm text-muted-foreground">
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
      </SettingsCard>

      <SettingsCard className="mt-4">
        <p className="text-sm font-medium text-foreground">Merge agent</p>
        <p className="-mt-3 text-sm text-muted-foreground">
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
      </SettingsCard>
    </div>
  );
}

function KnowledgeBaseSection({ settings, onUpdate }: SectionProps) {
  const kb = settings.knowledgeBase;
  const [path, setPath] = useState(kb.path);
  useEffect(() => setPath(kb.path), [kb.path]);
  const save = (patch: Partial<typeof kb>) =>
    onUpdate({ knowledgeBase: { ...kb, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Knowledge Base</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A folder of notes and files in its own Git repository. Agents search,
        read and write it with the <code>kb_*</code> tools and commit what they
        change; you browse it under Knowledge and can edit it with any editor.
        Turned off, agents get no Knowledge Base tools and the Knowledge view is
        hidden; the folder itself is left as it is.
      </p>

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Use a Knowledge Base"
          checked={kb.enabled}
          onChange={(enabled) => save({ enabled })}
        />

        <Field label="Folder">
          <Input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            onBlur={() => {
              if (path.trim() !== kb.path) save({ path: path.trim() });
            }}
            placeholder="<data folder>/knowledge"
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Empty uses the data folder&apos;s <code>knowledge</code> folder; a
            relative path is taken under the data folder. A folder that is not a
            Git repository yet becomes one. Nothing is ever pushed or pulled.
          </p>
          {kb.effectivePath ? (
            <p className="mt-1 text-sm text-muted-foreground">
              In use: <span className="font-mono">{kb.effectivePath}</span>
            </p>
          ) : null}
        </Field>
      </SettingsCard>
    </div>
  );
}

function PdfConversionSection({
  models,
  settings,
  onUpdate,
}: AgentSectionProps) {
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
      <h2 className="text-sm font-semibold">PDF conversion</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The <code>convert_pdf</code> tool converts born-digital PDFs to Markdown
        offline (no model, no settings). When a PDF has no text layer
        (scanned/image), it can fall back to Claude, which transcribes the pages
        as a document block. Only that fallback is configured here.
      </p>

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable the Claude fallback for scanned PDFs"
          checked={pdf.fallbackEnabled}
          onChange={(fallbackEnabled) => save({ fallbackEnabled })}
        />

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
            <Input
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
            />
          </Field>
        </div>

        <FieldDescription>
          The fallback is capped at 30 pages to bound cost; larger scanned PDFs
          return their (empty) text layer with a note. Disabling it makes
          scanned PDFs return low-text only, never calling Claude.
        </FieldDescription>

        {claudeModels.length === 0 && (
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            No Claude SDK models are available. Enable the Claude SDK
            integration to configure the fallback.
          </div>
        )}
      </SettingsCard>
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
      <h2 className="text-sm font-semibold">Dictation</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The composer mic button transcribes speech locally on this machine — no
        audio leaves the server, and no external service is involved. Hold the
        button to talk, or tap it to keep recording hands-free; the transcript
        lands in the draft and is never sent for you.
      </p>

      {status && (
        <Alert className="mt-4">
          <AlertDescription>
            {status.configured ? (
              <>
                Ready, using{" "}
                <span className="text-foreground">{status.modelId}</span>. The
                recognizer starts on first use (about two seconds to load) and
                releases its memory after an idle period.
              </>
            ) : (
              <>
                {status.reason ?? "Dictation is not configured on this server."}
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <SettingsCard className="mt-6">
        <PreferenceToggle
          checked={speech.enabled}
          onChange={(enabled) => save({ enabled })}
          label="Show the dictation button"
          description="Turn this off to hide the microphone from the composer entirely."
        />

        {models.length > 1 && (
          <Field label="Model">
            <NativeSelect
              value={speech.modelId || models[0]}
              onChange={(e) => save({ modelId: e.target.value })}
              className="w-full"
            >
              {models.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </NativeSelect>
            <p className="text-sm text-muted-foreground">
              Switching takes effect on the next dictation; the previous model
              is released.
            </p>
          </Field>
        )}
      </SettingsCard>

      <SettingsCard className="mt-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Vocabulary</div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              Fix words the recognizer reliably gets wrong — names, products,
              jargon. Each rule rewrites a spoken phrase to its written form
              after transcription. Matching is whole-word and ignores case; the
              written form is inserted exactly as typed.
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus />
            Add rule
          </Button>
        </div>

        {draft.length === 0 ? (
          <EmptyBox>
            No rules. Transcripts are used exactly as the model produced them.
          </EmptyBox>
        ) : (
          <div className="space-y-2">
            {draft.map((rule, index) => (
              <div key={keyFor(index)} className="flex items-end gap-2">
                <UiField className="min-w-0 flex-1">
                  <FieldLabel
                    htmlFor={`speech-from-${keyFor(index)}`}
                    className={index === 0 ? undefined : "sr-only"}
                  >
                    Heard as
                  </FieldLabel>
                  <Input
                    id={`speech-from-${keyFor(index)}`}
                    type="text"
                    value={rule.from}
                    onChange={(e) =>
                      updateRule(index, { from: e.target.value })
                    }
                    placeholder="forge joe"
                    autoCapitalize="none"
                  />
                </UiField>
                <UiField className="min-w-0 flex-1">
                  <FieldLabel
                    htmlFor={`speech-to-${keyFor(index)}`}
                    className={index === 0 ? undefined : "sr-only"}
                  >
                    Written as
                  </FieldLabel>
                  <Input
                    id={`speech-to-${keyFor(index)}`}
                    type="text"
                    value={rule.to}
                    onChange={(e) => updateRule(index, { to: e.target.value })}
                    placeholder="Forgejo"
                    autoCapitalize="none"
                  />
                </UiField>
                <IconButton
                  label="Remove rule"
                  title="Remove rule"
                  onClick={() => removeRule(index)}
                >
                  <Trash2 />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <Field label="Try it">
          <Input
            ref={sampleRef}
            type="text"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Paste or dictate a transcript to see your rules applied"
          />
          {sample.trim() ? (
            <Alert>
              <AlertDescription>
                {previewChanged ? preview : "No rule matched this text."}
              </AlertDescription>
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              The preview runs the same rules the server applies, so a rule that
              works here works when you dictate.
            </p>
          )}
        </Field>
      </SettingsCard>

      {recent.length > 0 && (
        <SettingsCard className="mt-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">Recent dictations</div>
              <div className="mt-0.5 text-sm text-muted-foreground">
                What the recognizer actually wrote, so you can see the wording a
                rule needs to match. Tap one to load it above and check a rule
                against it. Kept in this browser only — the server stores no
                transcripts.
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearRecentTranscripts();
                setRecent([]);
              }}
            >
              <Trash2 />
              Clear
            </Button>
          </div>
          <div className="space-y-1.5">
            {recent.map((entry) => (
              <Item
                key={`${entry.at}`}
                variant="outline"
                render={
                  <button
                    type="button"
                    onClick={() => applyAsSample(entry.text)}
                    title="Load into Try it"
                  />
                }
              >
                <ItemContent>{entry.text}</ItemContent>
                <Badge variant="secondary">{transcriptAge(entry.at)}</Badge>
              </Item>
            ))}
          </div>
        </SettingsCard>
      )}

      <Advanced>
        <div className="space-y-3 p-1">
          <Field label="Recognizer threads">
            <Input
              type="number"
              min={settingBounds("speechToText.numThreads").min}
              max={settingBounds("speechToText.numThreads").max}
              value={speech.numThreads}
              onChange={(e) => save({ numThreads: Number(e.target.value) })}
            />
            <p className="text-sm text-muted-foreground">
              More threads decode faster up to a point; measured gains flatten
              past 8 on this machine.
            </p>
          </Field>
          <Field label="Release memory after (seconds idle)">
            <Input
              type="number"
              min={settingBounds("speechToText.idleShutdownSeconds").min}
              max={settingBounds("speechToText.idleShutdownSeconds").max}
              value={speech.idleShutdownSeconds}
              onChange={(e) =>
                save({ idleShutdownSeconds: Number(e.target.value) })
              }
            />
            <p className="text-sm text-muted-foreground">
              The loaded model holds roughly 2 GB. 0 keeps it resident
              permanently, trading that memory for never paying the load again.
            </p>
          </Field>
          <Field label="Maximum utterance (seconds)">
            <Input
              type="number"
              min={settingBounds("speechToText.maxUtteranceSeconds").min}
              max={settingBounds("speechToText.maxUtteranceSeconds").max}
              value={speech.maxUtteranceSeconds}
              onChange={(e) =>
                save({ maxUtteranceSeconds: Number(e.target.value) })
              }
            />
            <p className="text-sm text-muted-foreground">
              Recording stops automatically at this length.
            </p>
          </Field>
        </div>
      </Advanced>
    </div>
  );
}

function PromptRefinementSection({
  models,
  settings,
  onUpdate,
}: AgentSectionProps) {
  const refinement = settings.promptRefinement;

  const save = (patch: Partial<typeof refinement>) =>
    onUpdate({ promptRefinement: { ...refinement, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Prompt refinement</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The composer refine button uses a dedicated no-tool agent to clean up
        dictated or rough draft prompts before they are sent. It receives the
        draft plus recent visible user/assistant context only; tool calls, tool
        results, and thinking blocks are excluded.
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        Recommendation:{" "}
        <span className="text-foreground">GitHub Copilot / GPT-4.1</span> with
        <span className="text-foreground"> Thinking off</span> or minimal. The
        task is mostly rewriting and should be fast.
      </p>

      <SettingsCard className="mt-6">
        <AgentModelFields
          models={models}
          provider={refinement.provider}
          modelId={refinement.modelId}
          thinkingLevel={refinement.thinkingLevel}
          credentialProfileId={refinement.credentialProfileId}
          modelLabel="Refinement model"
          onChange={save}
        />

        <FieldDescription>
          The refinement agent is instructed to preserve intent and meaning,
          avoid adding new facts or requirements, and return only the improved
          Markdown prompt.
        </FieldDescription>

        {models.length === 0 && (
          <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
            No models are available. Log in with terminal pi first.
          </div>
        )}
      </SettingsCard>
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
      <h2 className="text-sm font-semibold">Task intake agent</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Slack message shortcuts save a Task first, then this dedicated agent
        turns the Slack context into a concrete action. It can use enabled
        integrations for bounded, read-only research when that makes the Task
        more complete; it cannot change external systems. If context loading,
        research, or curation fails, the saved Task remains marked for retry
        when you use the shortcut again.
      </p>
      <SettingsCard className="mt-6">
        <Field label="Automatic project">
          <NativeSelect
            value={agent.projectId}
            onChange={(event) => save({ projectId: event.target.value })}
            className="w-full"
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
          </NativeSelect>
          <p className="mt-1 text-sm text-muted-foreground">
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
          <Textarea
            value={agent.additionalInstructions}
            onChange={(e) => save({ additionalInstructions: e.target.value })}
            rows={5}
            maxLength={8000}
            placeholder="For example: prefer concise technical titles and include unresolved questions."
          />
          <p className="mt-1 text-sm text-muted-foreground">
            Optional style or context guidance. It cannot override the fixed
            safety and Task JSON contract.
          </p>
        </Field>
        <FieldDescription>
          The agent can use a strict read-only subset of your enabled Personal
          Assistant integrations, with a ten-call research budget and no native
          file or shell access. It must return a validated title/description
          JSON object and cannot create, delete, or mutate Tasks or external
          systems.
        </FieldDescription>
      </SettingsCard>
    </div>
  );
}

function IntegrationStatusBanner({
  status,
}: {
  status: { ok: boolean; message: string } | null;
}) {
  if (!status) return null;
  return status.ok ? (
    <Badge variant="success" className="mt-4">
      <CheckCircle2 />
      {status.message}
    </Badge>
  ) : (
    <ErrorNote className="mt-4" message={status.message} />
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
      <h2 className="text-sm font-semibold">Jira</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Jira uses your Atlassian email and an API token (Basic auth). The token
        is stored server-side and never sent back to the browser. The Atlassian
        host is set by the deployment.
      </p>
      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable Jira tools for the Assistant agent"
          checked={enabled}
          onChange={setEnabled}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Jira host (configured by deployment)">
            <Input
              value={jira.jiraHost}
              placeholder="Not configured (jira.host in app config)"
              disabled
            />
          </Field>
          <Field label="Atlassian email">
            <Input
              value={atlassianEmail}
              onChange={(e) => setAtlassianEmail(e.target.value)}
              placeholder="you@example.com"
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
          <Button onClick={saveAndTest}>Save and test</Button>
          {jira.atlassianTokenConfigured && (
            <Button variant="outline" onClick={clearToken}>
              Clear token
            </Button>
          )}
        </div>
      </SettingsCard>
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
      <h2 className="text-sm font-semibold">Confluence</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Confluence is the same Atlassian site as Jira and uses the email and API
        token saved there. The host is set by the deployment.
      </p>
      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable Confluence tools for the Assistant agent"
          checked={enabled}
          onChange={setEnabled}
        />

        <Field label="Confluence host (configured by deployment)">
          <Input value={confluence.confluenceHost} disabled />
        </Field>

        {!confluence.credentialsAvailable && (
          <Alert variant="warning" role="note">
            <AlertDescription>
              No Atlassian credentials yet. Enable Jira and save an email and
              API token under Settings → Jira; Confluence shares them.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={() => onSaveAndTest({ enabled })}>
            Save and test
          </Button>
        </div>
      </SettingsCard>
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
      <h2 className="text-sm font-semibold">Tempo</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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
      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable Tempo tools for the Assistant agent"
          checked={enabled}
          onChange={setEnabled}
        />

        <Field label="Tempo API base URL">
          <Input
            value={apiBaseUrl}
            onChange={(e) => setApiBaseUrl(e.target.value)}
            placeholder="https://api.tempo.io/4"
          />
          <span className="mt-1 block text-sm text-muted-foreground">
            Moving to another host disconnects Tempo.
          </span>
        </Field>

        <div className="text-sm text-muted-foreground">
          {connected
            ? "Connected to Tempo. If authorization stops working, reauthorize below."
            : "Not authorized yet."}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={savePreferences}>Save preferences</Button>
          <Button
            variant="outline"
            onClick={connect}
            disabled={!tempo.oauthClientConfigured}
          >
            {connected ? "Reauthorize" : "Connect Tempo"}
          </Button>
          {connected && (
            <Button variant="outline" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>
      </SettingsCard>
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
  }, [google.enabled]);

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

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabled(next);
    onUpdateGoogle({ enabled: next });
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
        <div>
          <h2 className="text-base font-semibold">Google Workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect Google to use Calendar, Gmail, Drive, and Meet with the
            Assistant.
          </p>
        </div>
      </div>

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Use Google Workspace"
          description="Allow the Assistant to use your connected account."
          checked={enabled}
          ariaLabel="Enable Google Workspace"
          disabled={!connected}
          onChange={toggleEnabled}
        />

        <div className="space-y-1">
          <Badge
            variant={
              connected
                ? google.gmailArchiveAuthorized
                  ? "success"
                  : "warning"
                : "secondary"
            }
          >
            {connected && google.gmailArchiveAuthorized ? (
              <CheckCircle2 />
            ) : (
              <AlertTriangle />
            )}
            {connectedText}
          </Badge>
          {!connected ? (
            <div className="mt-1 text-sm text-muted-foreground">
              {google.oauthClientConfigured
                ? "Sign in with Google to connect your account."
                : "Google sign-in is not available yet. The app administrator needs to finish the Google setup."}
            </div>
          ) : !google.gmailArchiveAuthorized ? (
            <Alert variant="warning" role="note">
              <AlertDescription>
                Email archiving needs updated Google permission. Reauthorize
                once to enable it.
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        {oauthStartedAt !== null && (
          <Alert role="status">
            {oauthPhase === "checking" ? <Spinner size="sm" /> : <RefreshCw />}
            <AlertDescription>
              {oauthPhase === "opened"
                ? "Complete Google sign-in in your browser, then return here to refresh the connection."
                : "Checking Google Workspace authorization…"}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            variant={connected ? "outline" : "default"}
            onClick={() => void startOAuth()}
            disabled={!google.oauthClientConfigured}
            busy={oauthOpening}
          >
            {connected ? "Reauthorize" : "Sign in with Google"}
          </Button>
          {connected && (
            <Button variant="outline" onClick={disconnect}>
              Sign out
            </Button>
          )}
        </div>
      </SettingsCard>

      {oauthError && <ErrorNote message={oauthError} />}
      {visibleStatus && !visibleStatus.ok && (
        <ErrorNote
          className="mt-4"
          message={
            <>
              {visibleStatus.message}
              <p>
                Try signing in again. If the problem continues, ask the app
                administrator to check the Google setup.
              </p>
            </>
          }
        />
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
      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Use Slack"
          description="Allow the Assistant to use your connected Slack account."
          checked={enabled}
          ariaLabel="Enable Slack"
          disabled={!connected}
          onChange={toggleEnabled}
        />

        <div className="space-y-1">
          <Badge
            variant={
              checking
                ? "secondary"
                : healthy
                  ? "success"
                  : warning
                    ? "warning"
                    : "secondary"
            }
          >
            {checking ? (
              <Spinner size="sm" />
            ) : healthy ? (
              <CheckCircle2 />
            ) : (
              <AlertTriangle />
            )}
            {checking
              ? "Checking Slack connection…"
              : healthy
                ? "Connected to Slack"
                : warning
                  ? "Slack needs attention"
                  : "Not connected"}
          </Badge>
          <div className="mt-1 text-sm text-muted-foreground">
            {warning
              ? "Sign out and connect Slack again. If the problem continues, ask the app administrator for help."
              : connected
                ? "Your Slack account is connected."
                : "Sign in to connect your Slack account."}
          </div>
        </div>

        {oauthStartedAt !== null && (
          <Alert role="status">
            <Spinner size="sm" />
            <AlertDescription>
              Complete Slack authorization in the opened tab.
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          {!connected ? (
            <Button
              onClick={startOAuth}
              disabled={!slack.oauthClientConfigured}
            >
              Sign in with Slack
            </Button>
          ) : (
            <Button variant="outline" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </SettingsCard>
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
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
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
      <h2 className="text-sm font-semibold">Context7</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable the Context7 docs-search tools for agents"
          checked={enabled}
          onChange={setEnabled}
        />

        <SecretField
          label="Context7 API key"
          configured={context7.apiKeyConfigured}
          value={apiKey}
          onChange={setApiKey}
        />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={saveAndTest}>Save and test</Button>
          <Button variant="outline" onClick={onTestContext7}>
            Test saved key
          </Button>
        </div>
      </SettingsCard>
      <IntegrationStatusBanner status={status} />
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
      <h2 className="text-sm font-semibold">GitHub</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable the GitHub tools for agents"
          checked={enabled}
          onChange={setEnabled}
        />

        <SecretField
          label="Personal access token"
          configured={github.tokenConfigured}
          value={token}
          onChange={setToken}
        />

        <Field label="Default owner (optional)">
          <Input
            type="text"
            value={defaultOwner}
            onChange={(e) => setDefaultOwner(e.target.value)}
            placeholder="e.g. acme"
          />
        </Field>

        <div className="space-y-1">
          <PreferenceToggle
            label="Let builds read private GitHub packages"
            checked={packageProxyEnabled}
            onChange={setPackageProxyEnabled}
          />
          <p className="text-sm text-muted-foreground">
            Runs a local proxy that adds this token to requests for GitHub
            package registries (<span className="font-mono">maven</span>,{" "}
            <span className="font-mono">npm</span>,{" "}
            <span className="font-mono">nuget</span>), so builds in agent
            worktrees can resolve private dependencies without ever holding the
            token. Other hosts are passed through untouched.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={saveAndTest}>Save and test</Button>
          <Button variant="outline" onClick={onTestGithub}>
            Test saved token
          </Button>
        </div>
      </SettingsCard>
      <IntegrationStatusBanner status={status} />
      {status?.scopes && status.scopes.length > 0 && (
        <Advanced>
          <p className="text-sm text-muted-foreground">
            Token scopes:{" "}
            <span className="font-mono">{status.scopes.join(", ")}</span>
          </p>
        </Advanced>
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
      <h2 className="text-sm font-semibold">Forgejo</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable the Forgejo integration"
          checked={enabled}
          onChange={setEnabled}
        />

        <Field label="Instance base URL">
          <Input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://git.example.com"
          />
          <p className="text-sm text-muted-foreground">
            Moving to another host clears the saved token.
          </p>
        </Field>

        <SecretField
          label="Access token"
          configured={forgejo.tokenConfigured}
          value={token}
          onChange={setToken}
        />

        <Field label="Default owner (optional)">
          <Input
            type="text"
            value={defaultOwner}
            onChange={(e) => setDefaultOwner(e.target.value)}
            placeholder="e.g. my-org"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={saveAndTest}>Save and test</Button>
          <Button variant="outline" onClick={onTestForgejo}>
            Test saved settings
          </Button>
        </div>
      </SettingsCard>
      <IntegrationStatusBanner status={status} />
      {status?.version && (
        <Advanced>
          <p className="text-sm text-muted-foreground">
            Server version: <span className="font-mono">{status.version}</span>
          </p>
        </Advanced>
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
      <h2 className="text-sm font-semibold">Web Search</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable the web_search tool for agents"
          checked={enabled}
          onChange={setEnabled}
        />

        <SecretField
          label="Brave Search API key"
          configured={brave.apiKeyConfigured}
          value={apiKey}
          onChange={setApiKey}
        />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={saveAndTest}>Save and test</Button>
          <Button variant="outline" onClick={onTestBrave}>
            Test saved key
          </Button>
        </div>
      </SettingsCard>
      <IntegrationStatusBanner status={status} />
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
      <h2 className="text-sm font-semibold">OpenAI-compatible endpoint</h2>
      <p className="mt-1 text-sm text-muted-foreground">
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

      <SettingsCard className="mt-6">
        <PreferenceToggle
          label="Enable these models in the model picker"
          checked={enabled}
          onChange={setEnabled}
        />

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenAI-compatible"
          />
        </Field>

        <Field label="Base URL">
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://llm.example.net/v1"
          />
          <span className="mt-1 block text-sm text-muted-foreground">
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
          <NativeSelect
            value={thinkingFormat}
            onChange={(e) =>
              setThinkingFormat(
                e.target.value as OpenAiCompatibleThinkingFormat,
              )
            }
            className="w-full"
          >
            {OPENAI_COMPATIBLE_THINKING_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format === "none" ? "None — models do not reason" : format}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <div className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">
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
          <Button onClick={saveAndTest}>Save and discover models</Button>
          <Button variant="outline" onClick={onTestOpenAiCompatible}>
            Test saved provider
          </Button>
          {provider.apiKeyConfigured && (
            <Button variant="outline" onClick={removeKey}>
              Remove key
            </Button>
          )}
        </div>
      </SettingsCard>
      <IntegrationStatusBanner status={status} />

      {models.length > 0 && (
        <SettingsCard className="mt-4">
          <div className="mb-2 text-sm font-semibold text-foreground">
            Discovered models
          </div>
          <ul className="space-y-2">
            {models.map((model) => (
              <Item key={model.id} render={<li />} variant="outline">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {model.name}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {model.input.join("+")} ·{" "}
                      {model.reasoning ? "reasoning" : "non-reasoning"}
                      {model.status ? ` · ${model.status}` : ""}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <div>{model.contextWindow.toLocaleString()} ctx</div>
                    <div>{model.maxTokens.toLocaleString()} max out</div>
                  </div>
                </div>
              </Item>
            ))}
          </ul>
        </SettingsCard>
      )}
    </div>
  );
}

function BrowserToolsSettingsSection({ settings, onUpdate }: SectionProps) {
  const browserTools = settings.browserTools;
  const save = (patch: Partial<AppSettings["browserTools"]>) =>
    onUpdate({ browserTools: { ...browserTools, ...patch } });

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <h2 className="text-sm font-semibold">Browser tools</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Workshop/Developer sessions can use curated Playwright MCP browser tools
        for local UI verification — an ordinary tool group like Jira or Slack,
        discovered on demand rather than requiring a separate enable step.
      </p>
      <div className="mt-6 space-y-4">
        <SettingsCard>
          <h3 className="text-sm font-semibold text-foreground">
            Browser testing
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Curated Playwright MCP tools (navigate, snapshot, click, fill,
            screenshot, console, network). Screenshots/traces are stored as
            session artifacts, not in the repo.
          </p>
          <PreferenceToggle
            label="Launch browser in headed/debug mode instead of headless"
            checked={browserTools.headed}
            onChange={(headed) => save({ headed })}
          />
        </SettingsCard>
        <SettingsCard>
          <h3 className="text-sm font-semibold text-foreground">
            Raw browser MCP
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Advanced escape hatch for direct Playwright MCP tool calls by name,
            for capabilities missing from the standard browser tools. Off by
            default.
          </p>
          <PreferenceToggle
            label="Enable raw browser MCP"
            checked={browserTools.rawMcpEnabled}
            onChange={(rawMcpEnabled) => save({ rawMcpEnabled })}
          />
        </SettingsCard>
      </div>
    </div>
  );
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
      <RadioGroup
        aria-label="Text size"
        value={String(value)}
        onValueChange={(next) => onChange(Number(next) as TextScale)}
        className="flex flex-wrap gap-4"
      >
        {TEXT_SCALE_OPTIONS.map((option) => (
          <FieldLabel key={option}>
            <RadioGroupItem value={String(option)} />
            {option}%
          </FieldLabel>
        ))}
      </RadioGroup>
      {/* Live preview: because the selected scale is applied to the document
          root immediately, this sample reflows at the chosen size right away. */}
      <Item variant="muted">
        <ItemContent>
          <p className="text-xl font-semibold text-foreground">
            The quick brown fox
          </p>
          <p className="mt-1 text-sm text-foreground">
            Sample interface text jumps over the lazy dog at your selected size.
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Secondary metadata stays legible.
          </p>
          <p className="mt-2 font-mono text-sm text-muted-foreground">
            const scale = {value};
          </p>
        </ItemContent>
      </Item>
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
  const id = useId();
  return (
    <UiField>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {Children.map(children, (child) =>
        isValidElement<{ id?: string }>(child) &&
        (child.type === Input ||
          child.type === Textarea ||
          child.type === NativeSelect)
          ? cloneElement(child, { id })
          : child,
      )}
    </UiField>
  );
}

function SettingsCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  );
}

function Advanced({ children }: { children: React.ReactNode }) {
  return (
    <Accordion>
      <AccordionItem value="advanced">
        <AccordionTrigger>Advanced</AccordionTrigger>
        <AccordionContent>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
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
  const id = useId();
  return (
    <UiField>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupAddon>
          <KeyRound />
        </InputGroupAddon>
        <InputGroupInput
          id={id}
          aria-label={label}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            configured ? "Configured — leave blank to keep" : "Paste token"
          }
        />
      </InputGroup>
    </UiField>
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
        <h2 className="text-sm font-semibold">Models</h2>
        {/*
          The busy state is the whole point of this control: a refresh that
          changed nothing returns a list identical to the one on screen, so
          without a spinner a working button and a dead one look the same.
        */}
        <Button
          variant="outline"
          busy={refreshing}
          onClick={onRefresh}
          size="sm"
          title="Fetch provider model definitions again"
        >
          {refreshing ? null : <RefreshCw size={13} />}
          Refresh
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Drag a row by its grip to reorder — models appear in the picker
        top-to-bottom in this order. Hidden models stay usable if already
        selected; they just drop out of the list. Refresh fetches the model
        definitions again for every enabled provider and account, even if they
        were checked recently — a model released today shows up here as soon as
        the provider lists it. Account-specific availability follows the
        credential profile selected for a new session.
      </p>

      {models.length === 0 && (
        <EmptyBox className="mt-6">
          No models available. Enable and configure a provider first.
        </EmptyBox>
      )}

      {items.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Visible · {items.length}
          </div>
          <p aria-live="polite" className="sr-only">
            {moveAnnouncement}
          </p>
          <ul ref={listRef} className="flex flex-col gap-1">
            {items.map((m, i) => {
              const key = modelKey(m);
              return (
                <Item
                  key={key}
                  render={<li />}
                  variant={draggingKey === key ? "muted" : "outline"}
                >
                  {/*
                    The grip is the only drag surface, and a real button: a
                    whole row taking the gesture would swallow the list's own
                    scroll on touch, and the arrow keys reorder without one.
                  */}
                  <IconButton
                    label={`Reorder ${m.name} (${m.provider}), position ${i + 1} of ${items.length} — drag, or use the arrow keys`}
                    {...handleProps(i)}
                  >
                    <GripVertical />
                  </IconButton>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm text-foreground">
                      <span className="truncate">{m.name}</span>
                      {m.reasoning && (
                        <Brain
                          size={11}
                          className="shrink-0 text-muted-foreground"
                        />
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.provider}
                    </div>
                  </div>
                  <IconButton
                    label="Hide model"
                    onClick={() => hide(key)}
                    title="Hide model"
                  >
                    <Eye />
                  </IconButton>
                </Item>
              );
            })}
          </ul>
        </div>
      )}

      {hidden.length > 0 && (
        <div className="mt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Hidden · {hidden.length}
          </div>
          <ul className="flex flex-col gap-1">
            {hidden.map((m) => (
              <Item key={modelKey(m)} render={<li />} variant="muted">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-muted-foreground">
                    {m.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {m.provider}
                  </div>
                </div>
                <IconButton
                  label="Show model"
                  onClick={() => show(modelKey(m))}
                  title="Show model"
                >
                  <EyeOff />
                </IconButton>
              </Item>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
