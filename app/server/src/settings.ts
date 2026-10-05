import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AppearanceSettings,
  AppSettings,
  CalendarDaySessionSettings,
  ClaudeSdkSettings,
  CommitAgentSettings,
  DayScanSettings,
  MeetingMinutesScannerSettings,
  MemoryLearningMode,
  MemorySettings,
  ModelSettings,
  PdfConversionSettings,
  PeerSpawnRuntime,
  PermanentAssistantSettings,
  PrAgentSettings,
  PromptRefinementSettings,
  SessionNamingSettings,
  SkillToggles,
  SpeechToTextSettings,
  SpeechVocabularyEntry,
  TaskIntakeAgentSettings,
  ThinkingLevel,
  BrowserToolSettings,
  WorktreeSettings,
} from "@assistant/shared";
import {
  CLAUDE_SDK_PROVIDER,
  DEFAULT_HELPER_MODEL,
  DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  isPeerRuntimeRelativeCost,
  MAX_PEER_RUNTIME_DESCRIPTION_CHARS,
  MAX_PEER_SPAWN_RUNTIMES,
  MAX_SESSION_PEER_PROMPT_MAX_HOPS,
  MAX_WORKTREE_REMOTE_FETCH_MINUTES,
  MEMORY_LEARNING_MODES,
  MEMORY_SETTINGS_LIMITS,
  MIN_SESSION_PEER_PROMPT_MAX_HOPS,
  SPEECH_TO_TEXT_LIMITS,
  THINKING_LEVELS,
  clampInt,
  clampNumber,
  isSafeSkillName,
  normalizeBackgroundWorkSettings,
} from "@assistant/shared";
import { APP_SETTINGS_PATH, readStoredAppSettings } from "./appSettingsFile.ts";
import { getBraveSettings } from "./braveSettings.ts";
import { getOpenAiCompatibleSettings } from "./openAiCompatibleSettings.ts";
import { getContext7Settings } from "./context7Settings.ts";
import { getForgejoSettings } from "./forgejoSettings.ts";
import { getGithubSettings } from "./githubSettings.ts";
import { getGoogleSettings } from "./googleSettings.ts";
import { getConfluenceSettings } from "./confluenceSettings.ts";
import { getJiraSettings } from "./jiraSettings.ts";
import { getSlackSettings } from "./slackSettings.ts";
import { getTempoSettings } from "./tempoSettings.ts";
import { sanitizeSlotPinsDeep } from "./settingsModelSlots.ts";
import {
  invalidateUserProfileCache,
  normalizeProfileSettings,
  profileSettingsProjection,
} from "./userProfile.ts";

const DEFAULT_MODEL_SETTINGS: ModelSettings = { hidden: [], order: [] };
const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  separatorBeforeFinalResponse: true,
  separatorAtTurnEnd: true,
  turnStatsRow: true,
  // Opt-in detail: keeps the stats row compact by default, expands for cache-miss diagnosis.
  turnStatsPerRequest: false,
  knowledgePanelEnabled: false,
  worktreePanelEnabled: false,
};

function normalizeAppearanceSettings(
  settings: Partial<AppearanceSettings> | undefined,
): AppearanceSettings {
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
  return {
    separatorBeforeFinalResponse: bool(
      settings?.separatorBeforeFinalResponse,
      DEFAULT_APPEARANCE_SETTINGS.separatorBeforeFinalResponse,
    ),
    separatorAtTurnEnd: bool(
      settings?.separatorAtTurnEnd,
      DEFAULT_APPEARANCE_SETTINGS.separatorAtTurnEnd,
    ),
    turnStatsRow: bool(
      settings?.turnStatsRow,
      DEFAULT_APPEARANCE_SETTINGS.turnStatsRow,
    ),
    turnStatsPerRequest: bool(
      settings?.turnStatsPerRequest,
      DEFAULT_APPEARANCE_SETTINGS.turnStatsPerRequest,
    ),
    knowledgePanelEnabled: settings?.knowledgePanelEnabled === true,
    worktreePanelEnabled: settings?.worktreePanelEnabled === true,
  };
}
const DEFAULT_PERMANENT_ASSISTANT_SETTINGS: PermanentAssistantSettings = {
  name: "Larry",
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
  additionalInstructions: "",
};
const DEFAULT_SESSION_NAMING_SETTINGS: SessionNamingSettings = {
  enabled: true,
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
};

const DEFAULT_COMMIT_AGENT_SETTINGS: CommitAgentSettings = {
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
};

const DEFAULT_PR_AGENT_SETTINGS: PrAgentSettings = {
  ...DEFAULT_COMMIT_AGENT_SETTINGS,
};

const DEFAULT_PROMPT_REFINEMENT_SETTINGS: PromptRefinementSettings = {
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
};

/**
 * Dictation defaults. `modelId` empty means "first installed model" — which
 * model directories exist is deployment state (see speech/sttConfig.ts), so the
 * default must not name one. Threads are tuned for the deploy box (12 physical
 * cores; measured ~0.05× realtime at 8 threads, with no gain past that).
 */
const DEFAULT_SPEECH_TO_TEXT_SETTINGS: SpeechToTextSettings = {
  enabled: true,
  modelId: "",
  numThreads: 8,
  idleShutdownSeconds: 600,
  maxUtteranceSeconds: 120,
  vocabulary: [],
};

function normalizeSpeechToTextSettings(
  settings: Partial<SpeechToTextSettings> | undefined,
): SpeechToTextSettings {
  const vocabulary = Array.isArray(settings?.vocabulary)
    ? settings.vocabulary
    : [];
  return {
    enabled:
      typeof settings?.enabled === "boolean"
        ? settings.enabled
        : DEFAULT_SPEECH_TO_TEXT_SETTINGS.enabled,
    modelId:
      typeof settings?.modelId === "string" ? settings.modelId.trim() : "",
    numThreads: clampInt(
      settings?.numThreads,
      SPEECH_TO_TEXT_LIMITS.numThreads.min,
      SPEECH_TO_TEXT_LIMITS.numThreads.max,
      DEFAULT_SPEECH_TO_TEXT_SETTINGS.numThreads,
    ),
    // 0 keeps the ~2 GB recognizer resident for good; the cap avoids a "forever"
    // that is really just a very long leak.
    idleShutdownSeconds: clampInt(
      settings?.idleShutdownSeconds,
      SPEECH_TO_TEXT_LIMITS.idleShutdownSeconds.min,
      SPEECH_TO_TEXT_LIMITS.idleShutdownSeconds.max,
      DEFAULT_SPEECH_TO_TEXT_SETTINGS.idleShutdownSeconds,
    ),
    maxUtteranceSeconds: clampInt(
      settings?.maxUtteranceSeconds,
      SPEECH_TO_TEXT_LIMITS.maxUtteranceSeconds.min,
      SPEECH_TO_TEXT_LIMITS.maxUtteranceSeconds.max,
      DEFAULT_SPEECH_TO_TEXT_SETTINGS.maxUtteranceSeconds,
    ),
    vocabulary: vocabulary
      .filter(
        (entry): entry is SpeechVocabularyEntry =>
          typeof entry?.from === "string" && typeof entry?.to === "string",
      )
      .map((entry) => ({ from: entry.from.trim(), to: entry.to.trim() }))
      .filter((entry) => entry.from.length > 0)
      .slice(0, SPEECH_TO_TEXT_LIMITS.vocabularyEntries),
  };
}

const DEFAULT_MEETING_MINUTES_SCANNER_SETTINGS: MeetingMinutesScannerSettings =
  {
    ...DEFAULT_HELPER_MODEL,
    // Extraction now reads the FULL minutes/transcript, so give it room to reason.
    thinkingLevel: "medium",
    maxSourceChars: 60_000,
    maxSnippetChars: 20_000,
    timeoutMs: 90_000,
  };

const DEFAULT_PDF_CONVERSION_SETTINGS: PdfConversionSettings = {
  fallbackEnabled: true,
  provider: CLAUDE_SDK_PROVIDER,
  modelId: "sonnet",
  thinkingLevel: "off",
  timeoutMs: 180_000,
};

const DEFAULT_CALENDAR_DAY_SESSION_SETTINGS: CalendarDaySessionSettings = {
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
};

const DEFAULT_DAY_SCAN_SETTINGS: DayScanSettings = {
  identities: {},
  taskProposalPolicy: "auto",
  changelogIssueCap: 100,
  maxMinutesDocsPerRun: 6,
  schedule: {
    enabled: false,
    time: "07:00",
    synthesize: true,
  },
};

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Normalize a stored day-scan schedule (clamp/validate the time). */
function normalizeDayScanSchedule(
  stored: Partial<DayScanSettings["schedule"]> | undefined,
): DayScanSettings["schedule"] {
  const base = DEFAULT_DAY_SCAN_SETTINGS.schedule;
  const time =
    typeof stored?.time === "string" && TIME_OF_DAY_RE.test(stored.time.trim())
      ? stored.time.trim()
      : base.time;
  return {
    enabled: Boolean(stored?.enabled),
    time,
    synthesize:
      stored?.synthesize === undefined
        ? base.synthesize
        : Boolean(stored.synthesize),
  };
}

const DEFAULT_TASK_INTAKE_AGENT_SETTINGS: TaskIntakeAgentSettings = {
  ...DEFAULT_HELPER_MODEL,
  thinkingLevel: "off",
  projectId: "",
  additionalInstructions: "",
};

/** A slot's account pin is shape-normalized here; validity is resolved at use time. */
function normalizePin(value: unknown): { credentialProfileId?: string } {
  return typeof value === "string" && value.trim()
    ? { credentialProfileId: value.trim() }
    : {};
}

/** The shape every configured model slot shares: an explicit model + thinking level, optionally pinned to one account. */
interface ModelSlot {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  credentialProfileId?: string;
}

function normalizeSlot(
  slot: Partial<ModelSlot> | undefined,
  fallback: ModelSlot,
): ModelSlot {
  return {
    provider: slot?.provider || fallback.provider,
    modelId: slot?.modelId || fallback.modelId,
    thinkingLevel: slot?.thinkingLevel ?? fallback.thinkingLevel,
    ...normalizePin(slot?.credentialProfileId),
  };
}

const DEFAULT_BROWSER_TOOL_SETTINGS: BrowserToolSettings =
  normalizeBrowserToolSettings(undefined);

const DEFAULT_CLAUDE_SDK_SETTINGS: ClaudeSdkSettings = { enabled: false };

/** Memory is opt-in; its learning and maintenance preferences apply only once enabled. */
const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  loadingEnabled: false,
  learningMode: "adaptive",
  maintenanceEnabled: true,
  maxCards: 8,
  maxRenderedChars: 1_200,
  processor: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  maxCallsPerHour: 12,
  maxCostPerDayUsd: 1,
};

function normalizeMemorySettings(
  settings: Partial<MemorySettings> | undefined,
): MemorySettings {
  const s = settings ?? {};
  const learningMode: MemoryLearningMode = MEMORY_LEARNING_MODES.includes(
    s.learningMode as MemoryLearningMode,
  )
    ? (s.learningMode as MemoryLearningMode)
    : DEFAULT_MEMORY_SETTINGS.learningMode;
  const processor = s.processor;
  return {
    loadingEnabled: s.loadingEnabled === true,
    learningMode,
    maintenanceEnabled: s.maintenanceEnabled !== false,
    maxCards: clampInt(
      s.maxCards,
      MEMORY_SETTINGS_LIMITS.maxCards.min,
      MEMORY_SETTINGS_LIMITS.maxCards.max,
      DEFAULT_MEMORY_SETTINGS.maxCards,
    ),
    maxRenderedChars: clampInt(
      s.maxRenderedChars,
      MEMORY_SETTINGS_LIMITS.maxRenderedChars.min,
      MEMORY_SETTINGS_LIMITS.maxRenderedChars.max,
      DEFAULT_MEMORY_SETTINGS.maxRenderedChars,
    ),
    processor: {
      provider:
        typeof processor?.provider === "string" && processor.provider.trim()
          ? processor.provider
          : DEFAULT_MEMORY_SETTINGS.processor.provider,
      modelId:
        typeof processor?.modelId === "string" && processor.modelId.trim()
          ? processor.modelId
          : DEFAULT_MEMORY_SETTINGS.processor.modelId,
      thinkingLevel: THINKING_LEVELS.includes(
        processor?.thinkingLevel as ThinkingLevel,
      )
        ? (processor!.thinkingLevel as ThinkingLevel)
        : DEFAULT_MEMORY_SETTINGS.processor.thinkingLevel,
      ...normalizePin(processor?.credentialProfileId),
    },
    maxCallsPerHour: clampInt(
      s.maxCallsPerHour,
      MEMORY_SETTINGS_LIMITS.maxCallsPerHour.min,
      MEMORY_SETTINGS_LIMITS.maxCallsPerHour.max,
      DEFAULT_MEMORY_SETTINGS.maxCallsPerHour,
    ),
    maxCostPerDayUsd: clampNumber(
      s.maxCostPerDayUsd,
      MEMORY_SETTINGS_LIMITS.maxCostPerDayUsd.min,
      MEMORY_SETTINGS_LIMITS.maxCostPerDayUsd.max,
      DEFAULT_MEMORY_SETTINGS.maxCostPerDayUsd,
    ),
  };
}

function normalizeSessionPeerPromptMaxHops(value: unknown): number {
  return clampInt(
    value,
    MIN_SESSION_PEER_PROMPT_MAX_HOPS,
    MAX_SESSION_PEER_PROMPT_MAX_HOPS,
    DEFAULT_SESSION_PEER_PROMPT_MAX_HOPS,
  );
}

/**
 * Approved peer runtimes ([Task-595](pa://task/595)): exact rows, kept in the
 * user's order.
 *
 * Normalization only ever DROPS a row that cannot be addressed or repaired at
 * all: one with no id (nothing can name it), no model id (nothing was ever
 * approved), or a duplicate id. Everything else is KEPT even when it is broken
 * — a missing provider or account, a model that is gone, a thinking level the
 * model no longer supports or this build does not recognize — because those are
 * exactly the states the Settings surface must show so the human can repair or
 * delete the row. Dropping one makes a broken approval vanish silently.
 *
 * Runtime authorization fields are not rewritten, and the thinking level is
 * where that matters most: it is stored VERBATIM, never repaired to a default.
 * Substituting `medium` for an unrecognized level would leave a row that looks
 * approved and runs — on a thinking option the human never selected. Legacy
 * rows without a valid cost label read as `unknown`. Descriptions are bounded
 * but otherwise retained verbatim so a settings echo cannot consume spaces
 * while the user types; the model-facing roster normalizes their whitespace.
 */
function normalizePeerSpawnRuntimes(
  rows: readonly Partial<PeerSpawnRuntime>[] | undefined,
): PeerSpawnRuntime[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: PeerSpawnRuntime[] = [];
  for (const row of rows) {
    if (out.length >= MAX_PEER_SPAWN_RUNTIMES) break;
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const provider =
      typeof row?.provider === "string" ? row.provider.trim() : "";
    const modelId = typeof row?.modelId === "string" ? row.modelId.trim() : "";
    if (!id || !modelId || seen.has(id)) continue;
    seen.add(id);
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const description =
      typeof row?.description === "string"
        ? row.description.slice(0, MAX_PEER_RUNTIME_DESCRIPTION_CHARS)
        : "";
    out.push({
      id,
      ...(name ? { name } : {}),
      relativeCost: isPeerRuntimeRelativeCost(row.relativeCost)
        ? row.relativeCost
        : "unknown",
      ...(description ? { description } : {}),
      credentialProfileId:
        typeof row?.credentialProfileId === "string"
          ? row.credentialProfileId.trim()
          : "",
      provider,
      modelId,
      thinkingLevel:
        typeof row?.thinkingLevel === "string" ? row.thinkingLevel.trim() : "",
      enabled: row?.enabled !== false,
    });
  }
  return out;
}

const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  root: join(homedir(), "worktrees"),
  namingAgent: {
    ...DEFAULT_HELPER_MODEL,
    thinkingLevel: "off",
  },
  mergeAgent: {
    provider: CLAUDE_SDK_PROVIDER,
    modelId: "sonnet",
    thinkingLevel: "medium",
  },
  defaultMergeStrategy: "squash",
  remoteFetchMinutes: 10,
};

function normalizeRemoteFetchMinutes(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  )
    return DEFAULT_WORKTREE_SETTINGS.remoteFetchMinutes;
  return Math.min(value, MAX_WORKTREE_REMOTE_FETCH_MINUTES);
}

function normalizeWorktreeSettings(
  settings: Partial<WorktreeSettings> | undefined,
): WorktreeSettings {
  const strategy = settings?.defaultMergeStrategy;
  return {
    root:
      typeof settings?.root === "string" && settings.root.trim()
        ? settings.root.trim()
        : DEFAULT_WORKTREE_SETTINGS.root,
    namingAgent: normalizeSlot(
      settings?.namingAgent,
      DEFAULT_WORKTREE_SETTINGS.namingAgent,
    ),
    mergeAgent: normalizeSlot(
      settings?.mergeAgent,
      DEFAULT_WORKTREE_SETTINGS.mergeAgent,
    ),
    defaultMergeStrategy:
      strategy === "merge" || strategy === "rebase" || strategy === "squash"
        ? strategy
        : DEFAULT_WORKTREE_SETTINGS.defaultMergeStrategy,
    remoteFetchMinutes: normalizeRemoteFetchMinutes(
      settings?.remoteFetchMinutes,
    ),
  };
}

/** A patched section that is a map rather than a fixed shape must be one. */
function isRecordPatch(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Global skill toggles ([Task-613](pa://task/613)): a sparse map from declared
 * skill name to `"on"`/`"off"`.
 *
 * Two rules, and they pull in opposite directions on purpose.
 *
 * An entry is DROPPED when it could not name a skill or could not state one of
 * the two answers — a key outside the shared name rule, a value that is not
 * exactly `"on"` or `"off"`. Nothing is coerced: reading a stray truthy value
 * as `"on"` would enable a skill nobody enabled, which is the one direction
 * this section must never fail in.
 *
 * An entry is KEPT when the library does not currently declare that name. The
 * library is hand-authored, so a name is missing during an edit, a rename, a
 * checkout of another branch, or a scan that failed entirely; dropping it would
 * silently discard the user's decision and turn the skill off the moment it
 * came back. Nothing here consults the scanner, and a stored `"off"` is kept
 * for the same reason: it is what the user said, and `isSkillEnabled` gives it
 * the same effect as absence anyway.
 */
function normalizeSkillToggles(value: unknown): SkillToggles {
  if (!isRecordPatch(value)) return {};
  const out: SkillToggles = {};
  for (const [name, state] of Object.entries(value))
    if (isSafeSkillName(name) && (state === "on" || state === "off"))
      out[name] = state;
  return out;
}

const DEFAULT_PROJECTS_ROOT = join(homedir(), "projects");

function normalizeProjectsRoot(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : DEFAULT_PROJECTS_ROOT;
}

function normalizeBrowserToolSettings(
  settings: Partial<BrowserToolSettings> | undefined,
): BrowserToolSettings {
  return {
    headed: Boolean(settings?.headed),
    rawMcpEnabled: Boolean(settings?.rawMcpEnabled),
  };
}

/** Current settings, with defaults filled in for any missing section. */
export function getSettings(publicBaseUrl?: string): AppSettings {
  const stored = readStoredAppSettings();
  return {
    models: { ...DEFAULT_MODEL_SETTINGS, ...(stored.models ?? {}) },
    permanentAssistant: {
      ...DEFAULT_PERMANENT_ASSISTANT_SETTINGS,
      ...(stored.permanentAssistant ?? {}),
    },
    sessionNaming: {
      ...DEFAULT_SESSION_NAMING_SETTINGS,
      ...(stored.sessionNaming ?? {}),
    },
    commitAgent: {
      ...DEFAULT_COMMIT_AGENT_SETTINGS,
      ...(stored.commitAgent ?? {}),
    },
    prAgent: {
      ...DEFAULT_PR_AGENT_SETTINGS,
      ...(stored.prAgent ?? {}),
    },
    meetingMinutesScanner: {
      ...DEFAULT_MEETING_MINUTES_SCANNER_SETTINGS,
      ...(stored.meetingMinutesScanner ?? {}),
    },
    pdfConversion: {
      ...DEFAULT_PDF_CONVERSION_SETTINGS,
      ...(stored.pdfConversion ?? {}),
    },
    calendarDaySession: {
      ...DEFAULT_CALENDAR_DAY_SESSION_SETTINGS,
      ...(stored.calendarDaySession ?? {}),
    },
    dayScan: {
      ...DEFAULT_DAY_SCAN_SETTINGS,
      ...(stored.dayScan ?? {}),
      identities: { ...(stored.dayScan?.identities ?? {}) },
      schedule: normalizeDayScanSchedule(stored.dayScan?.schedule),
    },
    promptRefinement: {
      ...DEFAULT_PROMPT_REFINEMENT_SETTINGS,
      ...(stored.promptRefinement ?? {}),
    },
    speechToText: normalizeSpeechToTextSettings(stored.speechToText),
    taskIntakeAgent: {
      ...DEFAULT_TASK_INTAKE_AGENT_SETTINGS,
      ...(stored.taskIntakeAgent ?? {}),
      projectId: stored.taskIntakeAgent?.projectId?.trim() ?? "",
    },
    browserTools: normalizeBrowserToolSettings(
      stored.browserTools ?? DEFAULT_BROWSER_TOOL_SETTINGS,
    ),
    backgroundWork: normalizeBackgroundWorkSettings(stored.backgroundWork),
    claudeSdk: { ...DEFAULT_CLAUDE_SDK_SETTINGS, ...(stored.claudeSdk ?? {}) },
    worktrees: normalizeWorktreeSettings(stored.worktrees),
    projectsRoot: normalizeProjectsRoot(stored.projectsRoot),
    memory: normalizeMemorySettings(stored.memory),
    peerSpawnRuntimes: normalizePeerSpawnRuntimes(stored.peerSpawnRuntimes),
    sessionPeerPromptMaxHops: normalizeSessionPeerPromptMaxHops(
      stored.sessionPeerPromptMaxHops,
    ),
    skills: normalizeSkillToggles(stored.skills),
    appearance: normalizeAppearanceSettings(stored.appearance),
    profile: profileSettingsProjection(stored.profile),
    // Integration settings and secrets have dedicated private storage under
    // DATA_DIR/settings and their own update functions, so they are read here
    // rather than from the app-settings file.
    jira: getJiraSettings(),
    confluence: getConfluenceSettings(),
    tempo: getTempoSettings(publicBaseUrl),
    google: getGoogleSettings(publicBaseUrl),
    slack: getSlackSettings(),
    openAiCompatible: getOpenAiCompatibleSettings(),
    brave: getBraveSettings(),
    context7: getContext7Settings(),
    github: getGithubSettings(),
    forgejo: getForgejoSettings(),
  };
}

/**
 * Merge a patch into the stored settings (each provided section replaces the
 * existing one), persist atomically, and return the new settings. Throws if the
 * file cannot be written — the caller decides what the client sees.
 */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const stored = readStoredAppSettings();
  // Only these sections are persisted to the app-settings file. Secret-backed
  // integration sections have dedicated update functions and private storage.
  const persisted = {
    ...stored,
    ...(patch.models ? { models: patch.models } : {}),
    ...(patch.permanentAssistant
      ? {
          permanentAssistant: {
            ...DEFAULT_PERMANENT_ASSISTANT_SETTINGS,
            ...patch.permanentAssistant,
          },
        }
      : {}),
    ...(patch.sessionNaming ? { sessionNaming: patch.sessionNaming } : {}),
    ...(patch.commitAgent ? { commitAgent: patch.commitAgent } : {}),
    ...(patch.prAgent ? { prAgent: patch.prAgent } : {}),
    ...(patch.meetingMinutesScanner
      ? { meetingMinutesScanner: patch.meetingMinutesScanner }
      : {}),
    ...(patch.pdfConversion
      ? {
          pdfConversion: {
            ...DEFAULT_PDF_CONVERSION_SETTINGS,
            ...patch.pdfConversion,
          },
        }
      : {}),
    ...(patch.calendarDaySession
      ? { calendarDaySession: patch.calendarDaySession }
      : {}),
    ...(patch.dayScan
      ? {
          dayScan: {
            ...DEFAULT_DAY_SCAN_SETTINGS,
            ...patch.dayScan,
            schedule: normalizeDayScanSchedule(patch.dayScan.schedule),
          },
        }
      : {}),
    ...(patch.promptRefinement
      ? { promptRefinement: patch.promptRefinement }
      : {}),
    ...(patch.speechToText
      ? { speechToText: normalizeSpeechToTextSettings(patch.speechToText) }
      : {}),
    ...(patch.taskIntakeAgent
      ? {
          taskIntakeAgent: {
            ...DEFAULT_TASK_INTAKE_AGENT_SETTINGS,
            ...patch.taskIntakeAgent,
            projectId: patch.taskIntakeAgent.projectId.trim(),
          },
        }
      : {}),
    ...(patch.browserTools
      ? { browserTools: normalizeBrowserToolSettings(patch.browserTools) }
      : {}),
    // Normalized on the way IN as well as out: what the card echoes back has to
    // be the values a later admission will actually freeze.
    ...(patch.backgroundWork
      ? {
          backgroundWork: normalizeBackgroundWorkSettings(patch.backgroundWork),
        }
      : {}),
    ...(patch.claudeSdk ? { claudeSdk: patch.claudeSdk } : {}),
    ...(patch.worktrees
      ? { worktrees: normalizeWorktreeSettings(patch.worktrees) }
      : {}),
    ...(patch.projectsRoot !== undefined
      ? { projectsRoot: normalizeProjectsRoot(patch.projectsRoot) }
      : {}),
    ...(patch.memory ? { memory: normalizeMemorySettings(patch.memory) } : {}),
    // Only a real ARRAY replaces the roster. This section is the one whose
    // patch is a wholesale replacement, and its normalizer answers a non-array
    // with an empty list — so treating any truthy value as a patch would let a
    // malformed one delete every approval the user granted. An empty array is
    // still a legitimate patch: that is how the last row is removed.
    ...(Array.isArray(patch.peerSpawnRuntimes)
      ? {
          peerSpawnRuntimes: normalizePeerSpawnRuntimes(
            patch.peerSpawnRuntimes,
          ),
        }
      : {}),
    ...(patch.sessionPeerPromptMaxHops !== undefined
      ? {
          sessionPeerPromptMaxHops: normalizeSessionPeerPromptMaxHops(
            patch.sessionPeerPromptMaxHops,
          ),
        }
      : {}),
    // The toggle map is replaced WHOLE — a control sends the map it wants,
    // including every entry it is keeping — so, like the roster above, only a
    // real object may replace it: the normalizer answers anything else with an
    // empty map, and a malformed patch would then turn off every skill the user
    // enabled instead of failing. An empty object is still a legitimate patch;
    // that is how the last entry goes.
    ...(isRecordPatch(patch.skills)
      ? { skills: normalizeSkillToggles(patch.skills) }
      : {}),
    ...(patch.appearance
      ? { appearance: normalizeAppearanceSettings(patch.appearance) }
      : {}),
    // Merged over the stored profile, so a patch naming one field never
    // clears the other; the effective zone is a projection and never persists.
    ...(patch.profile
      ? {
          profile: normalizeProfileSettings({
            ...stored.profile,
            ...patch.profile,
          }),
        }
      : {}),
  };
  // Account pins are validated once, here on write: a pin naming an unknown
  // account or one of the wrong provider is never persisted. A pin to a
  // temporarily disabled account survives (resolveSlotAccount degrades it).
  //
  // Approved peer runtimes are deliberately held OUT of that walk: their
  // account is not a pin that may degrade to an automatic one, it is part of
  // what the human approved. A row whose account is unusable must stay visible
  // with its reason rather than lose the field that explains it.
  const { peerSpawnRuntimes: _peerRows, ...slotted } = persisted;
  const out = `${JSON.stringify(
    {
      ...sanitizeSlotPinsDeep(slotted),
      ...(persisted.peerSpawnRuntimes
        ? { peerSpawnRuntimes: persisted.peerSpawnRuntimes }
        : {}),
    },
    null,
    2,
  )}\n`;
  // Write to a sibling temp file then rename, so a crash mid-write can't leave
  // a truncated file behind. The settings dir may not exist yet on first save.
  mkdirSync(dirname(APP_SETTINGS_PATH), { recursive: true });
  const tmp = `${APP_SETTINGS_PATH}.tmp`;
  writeFileSync(tmp, out, "utf8");
  renameSync(tmp, APP_SETTINGS_PATH);
  invalidateUserProfileCache();
  return getSettings();
}
