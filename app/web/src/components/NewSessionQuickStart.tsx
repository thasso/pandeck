import {
  FileText,
  GitBranch,
  Hammer,
  House,
  Plus,
  Ellipsis,
} from "lucide-react";
import {
  supportedThinkingLevelsForModel,
  type ModelOption,
  type ProjectRecord,
  type AgentType,
  type SessionListItem,
  type SessionMode,
  type TaskSummary,
  type ThinkingLevel,
  type WorktreeRecord,
  type CredentialProfileSummary,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import { projectColor } from "../lib/projectDisplay.ts";
import { orderCredentialProfilesByProvider } from "../lib/credentialProfiles.ts";
import { DASHED_EDGE, EmptyBox, ErrorNote, Skeleton } from "./ui/load.tsx";
import {
  ModelQuickRow,
  ProviderAccountRow,
  QuickPill,
  QuickRow,
  QuickRowSplit,
  ThinkingSlider,
} from "./ui/RuntimePicker.tsx";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";

/**
 * The Build/Plan pills, in that order. The labelling follows the composer's
 * `ModeSelector` to the word (a binding epic decision, Task 305): "Plan" and
 * nothing more — no "read-only", no "safe", no lock glyph.
 */
const MODE_OPTIONS = [
  {
    value: "build" as SessionMode,
    label: "Build",
    title: "Start in Build",
    Icon: Hammer,
  },
  {
    value: "plan" as SessionMode,
    label: "Plan",
    title: "Start in Plan",
    Icon: FileText,
  },
];

/**
 * Order projects for selection surfaces by their newest linked session or Task
 * activity. Projects without either keep their registry order.
 */
export function orderProjectsByActivity(
  projects: ProjectRecord[],
  sessions: ReadonlyArray<Pick<SessionListItem, "projectId" | "updatedAt">>,
  tasks: ReadonlyArray<Pick<TaskSummary, "projectId" | "updatedAt">>,
): ProjectRecord[] {
  const lastActivity = new Map<string, number>();
  const recordActivity = (projectId: string | undefined, updatedAt: number) => {
    if (!projectId) return;
    lastActivity.set(
      projectId,
      Math.max(lastActivity.get(projectId) ?? 0, updatedAt),
    );
  };
  for (const session of sessions)
    recordActivity(session.projectId, session.updatedAt);
  for (const task of tasks) recordActivity(task.projectId, task.updatedAt);
  return [...projects].sort(
    (a, b) => (lastActivity.get(b.id) ?? 0) - (lastActivity.get(a.id) ?? 0),
  );
}

/**
 * Order worktrees by most recent work: the newest `updatedAt` of any session
 * linked to the worktree, falling back to the record's own `updatedAt` (0 for
 * synthetic main-checkout rows, which therefore rank by session activity only).
 */
export function orderWorktreesByActivity(
  worktrees: WorktreeRecord[],
  sessions: ReadonlyArray<{ id: string; updatedAt: number }>,
): WorktreeRecord[] {
  const sessionUpdatedAt = new Map(sessions.map((s) => [s.id, s.updatedAt]));
  const lastActivity = (worktree: WorktreeRecord) =>
    Math.max(
      worktree.updatedAt,
      ...worktree.sessionIds.map((id) => sessionUpdatedAt.get(id) ?? 0),
    );
  return [...worktrees].sort((a, b) => lastActivity(b) - lastActivity(a));
}

/** One worktree card in the "Start in a worktree" row. */
function WorktreeCard({
  worktree,
  selected,
  dot,
  projectName,
  onSelect,
}: {
  worktree: WorktreeRecord;
  selected: boolean;
  dot: string;
  projectName: string;
  onSelect: () => void;
}) {
  const label = worktree.isMain ? "main checkout" : worktree.branch;
  const WorktreeIcon = worktree.isMain ? House : GitBranch;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-quick-selected={selected || undefined}
      title={selected ? `Remove worktree ${label}` : `Start in ${label}`}
      onClick={onSelect}
      className={`flex min-w-[9.5rem] max-w-[13rem] shrink-0 snap-start flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        selected
          ? "border-primary/40 bg-accent"
          : "border-line bg-panel hover:border-line-strong hover:bg-raised"
      }`}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <WorktreeIcon
          size={13}
          className={
            selected
              ? "shrink-0 text-primary"
              : "shrink-0 text-muted-foreground"
          }
        />
        <span
          className={`min-w-0 flex-1 truncate text-caption font-medium ${selected ? "text-primary" : "text-fg"}`}
        >
          {label}
        </span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: dot }}
          aria-hidden
        />
        <span className="min-w-0 truncate text-caption text-faint">
          {projectName}
        </span>
      </span>
    </button>
  );
}

/**
 * @component NewSessionQuickStart
 * @purpose One-tap staging on the new-session landing: horizontally
 * snap-scrolling rows for project, worktree (recent work first, main checkouts
 * included), agent, provider account, model, and thinking level, filling the empty hero space above the
 * composer.
 * @useWhen The fresh new-chat surface shows the staged-context bar (Task 119) —
 * the worktree row stages through the same `stageWorktreeContext` state the
 * composer chips/sheet use (which also switches to the coding agent), and the
 * model/thinking rows drive the same staged runtime as the composer pickers.
 * @avoidWhen Any surface with messages, or flows that stage their own context
 * (starting from a document, the permanent Assistant).
 * @intent Native swipe on mobile (snap scroll), wheel/drag on desktop. Tapping
 * the selected worktree card clears it again; "More…" opens the full context
 * sheet without focusing the composer afterwards.
 */
export function NewSessionQuickStart({
  credentialProfiles = [],
  credentialProfilesLoaded = true,
  credentialProfilesError,
  onRetryCredentialProfiles,
  selectedCredentialProfileId = "default",
  onSelectCredentialProfile = () => {},
  usageIndicators = null,
  agentTypes,
  selectedAgentType,
  onSelectAgentType,
  mode,
  onSelectMode,
  worktrees,
  worktreesLoaded,
  projects,
  projectsLoaded,
  selectedProjectId,
  onSelectProject,
  selectedWorktreeId,
  onSelectWorktree,
  newWorktreeStaged,
  onSelectNewWorktree,
  onOpenPicker,
  models,
  selectedModel,
  onSelectModel,
  thinkingLevel,
  onSelectThinking,
}: {
  credentialProfiles?: CredentialProfileSummary[];
  /** Whether the account/model projection has data (including shell-cached data). */
  credentialProfilesLoaded?: boolean;
  /** A first-load or refresh failure; loaded rows stay mounted underneath it. */
  credentialProfilesError?: string | undefined;
  onRetryCredentialProfiles?: () => void;
  selectedCredentialProfileId?: string | undefined;
  onSelectCredentialProfile?: (profileId: string) => void;
  /**
   * Subscription-usage indicators from the server cache (`docs/usage.md`), or
   * null while the first snapshot has not arrived. Cards render the same slot
   * either way, so nothing reflows when it does.
   */
  usageIndicators?: UsageIndicator[] | null;
  /** Available personas for the top agent row (hidden when <2). */
  agentTypes: AgentType[];
  selectedAgentType: AgentType;
  onSelectAgentType: (agentType: AgentType) => void;
  /**
   * Build/Plan for the staged session, or undefined where the persona has no
   * mode axis. It shares the agent row: mode is a one-session choice the landing
   * page has to STATE, and stating it in the composer's pill strip alone is how
   * an inherited Plan used to go unnoticed.
   */
  mode?: SessionMode | undefined;
  onSelectMode?: ((mode: SessionMode) => void) | undefined;
  /** Active worktrees in display order (App pre-sorts by recent activity). */
  worktrees: WorktreeRecord[];
  /**
   * Whether the worktree list has been fetched at least once. While false the
   * row renders same-height skeleton cards so the hero doesn't jump when the
   * list arrives.
   */
  worktreesLoaded: boolean;
  /** Full registry list (archived included) for name/color lookups; the row itself shows active projects only. */
  projects: ProjectRecord[];
  /**
   * Whether the project registry has been fetched at least once. While false
   * the row renders same-height skeleton pills so the layout doesn't jump.
   */
  projectsLoaded: boolean;
  selectedProjectId: string | null;
  /** Stage (id) or clear (null) the project — App's `stageProjectContext`. */
  onSelectProject: (projectId: string | null) => void;
  selectedWorktreeId: string | null;
  /** Stage (id) or clear (null) the worktree — App's `stageWorktreeContext`. */
  onSelectWorktree: (worktreeId: string | null) => void;
  /**
   * Whether "+ New worktree" is the staged choice. The card only renders with a
   * project staged: there is no way to create a checkout without knowing which
   * repository it belongs to.
   */
  newWorktreeStaged: boolean;
  /** Stage/unstage "+ New worktree" — App's `stageNewWorktree`. */
  onSelectNewWorktree: (staged: boolean) => void;
  /** Open the composer's context sheet on the Worktree field. */
  onOpenPicker: () => void;
  /** Picker model options; the row mirrors the composer's model picker. */
  models: ModelOption[];
  selectedModel: ModelOption | undefined;
  onSelectModel: (model: ModelOption) => void;
  thinkingLevel: ThinkingLevel;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  // The worktree row narrows to the staged project; the cards keep their
  // project line regardless (stable two-line height, and the project stays
  // visible at a glance).
  const totalActiveWorktrees = worktrees.filter((w) => !w.removedAt).length;
  const activeWorktrees = worktrees
    .filter((w) => !w.removedAt)
    .filter((w) => !selectedProjectId || w.projectId === selectedProjectId);
  // Pinned order: "+ New worktree" (when a project is staged), then main
  // checkouts, a divider, then the rest in their activity order.
  const mainWorktrees = activeWorktrees.filter((w) => w.isMain);
  const otherWorktrees = activeWorktrees.filter((w) => !w.isMain);
  const showNewWorktreeCard = Boolean(selectedProjectId);
  const showWorktreeDivider =
    (showNewWorktreeCard || mainWorktrees.length > 0) &&
    otherWorktrees.length > 0;
  const activeProjects = projects.filter((p) => p.status !== "archived");
  const projectName = (projectId: string) =>
    projects.find((p) => p.id === projectId)?.name ??
    projectId.replace(/[-_]/g, " ");
  const worktreeDot = (projectId: string) => {
    const color = projects.find((p) => p.id === projectId)?.color;
    return projectColor({
      id: projectId,
      ...(color !== undefined ? { color } : {}),
    }).dot;
  };

  const thinkingLevels = supportedThinkingLevelsForModel(selectedModel);
  const orderedCredentialProfiles =
    orderCredentialProfilesByProvider(credentialProfiles);

  // Agent and mode are pills of the same size and both at most a few wide, so
  // they share a row when both are offered and each falls back to a row of its
  // own when it is alone.
  const agentPills =
    agentTypes.length > 1
      ? agentTypes.map((type) => {
          const display = AGENT_TYPE_DISPLAY[type];
          const selected = type === selectedAgentType;
          return (
            <QuickPill
              key={type}
              selected={selected}
              title={display.desc}
              onClick={() => onSelectAgentType(type)}
            >
              <display.Icon
                size={14}
                className={selected ? display.activeColor : display.pillColor}
              />
              <span className="min-w-0 truncate">{display.label}</span>
            </QuickPill>
          );
        })
      : null;
  const pickMode = onSelectMode;
  const modePills =
    mode && pickMode
      ? MODE_OPTIONS.map((option) => {
          const selected = option.value === mode;
          return (
            <QuickPill
              key={option.value}
              selected={selected}
              title={option.title}
              onClick={() => pickMode(option.value)}
            >
              <option.Icon
                size={14}
                className={selected ? "text-primary" : "text-muted-foreground"}
              />
              <span className="min-w-0 truncate">{option.label}</span>
            </QuickPill>
          );
        })
      : null;

  return (
    <div className="new-session-quick-start mt-6 flex w-full max-w-2xl flex-col gap-4">
      {!projectsLoaded ? (
        <QuickRow label="Project" busy>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden
              className="h-9 w-28 shrink-0 snap-start rounded-xl border border-line bg-panel"
            >
              <Skeleton className="m-2.5 h-4" />
            </div>
          ))}
        </QuickRow>
      ) : activeProjects.length > 1 ? (
        <QuickRow
          label="Project"
          scrollKey={`${selectedProjectId ?? ""}:${activeProjects.length}`}
        >
          {activeProjects.map((p) => {
            const selected = p.id === selectedProjectId;
            return (
              <QuickPill
                key={p.id}
                selected={selected}
                title={
                  selected ? `Remove project ${p.name}` : `Narrow to ${p.name}`
                }
                onClick={() => onSelectProject(selected ? null : p.id)}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: projectColor(p).dot }}
                  aria-hidden
                />
                <span className="min-w-0 truncate">{p.name}</span>
              </QuickPill>
            );
          })}
        </QuickRow>
      ) : null}

      {!worktreesLoaded ? (
        <QuickRow label="Start in a worktree" busy>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              aria-hidden
              className="flex min-w-[9.5rem] max-w-[13rem] shrink-0 snap-start flex-col items-start gap-1 rounded-xl border border-line bg-panel px-3 py-2.5"
            >
              {/* The card's two real lines, to the pixel: a card that changes
                  height when the answer lands takes the whole row with it. */}
              <Skeleton className="h-[19px] w-24" />
              <Skeleton className="h-[16px] w-16" />
            </div>
          ))}
        </QuickRow>
      ) : (
        <QuickRow
          label="Start in a worktree"
          scrollKey={`${selectedWorktreeId ?? ""}:${newWorktreeStaged}:${activeWorktrees.length}`}
        >
          {activeWorktrees.length === 0 ? (
            <EmptyBox variant="item">
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <GitBranch size={13} className="shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-medium">
                  No worktrees
                </span>
              </span>
              <span className="min-w-0 truncate">
                {selectedProjectId
                  ? `in ${projectName(selectedProjectId)}`
                  : "yet"}
              </span>
            </EmptyBox>
          ) : null}
          {selectedProjectId ? (
            <button
              type="button"
              role="option"
              aria-selected={newWorktreeStaged}
              data-quick-selected={newWorktreeStaged || undefined}
              title={
                newWorktreeStaged
                  ? "Don't create a worktree"
                  : `Create a worktree in ${projectName(selectedProjectId)} when you send`
              }
              onClick={() => onSelectNewWorktree(!newWorktreeStaged)}
              className={`flex min-w-[9.5rem] max-w-[13rem] shrink-0 snap-start flex-col items-start gap-1 rounded-xl border ${DASHED_EDGE} px-3 py-2.5 text-left transition-colors ${
                newWorktreeStaged
                  ? "border-primary/40 bg-accent"
                  : "border-line bg-panel hover:border-line-strong hover:bg-raised"
              }`}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <Plus
                  size={13}
                  className={
                    newWorktreeStaged
                      ? "shrink-0 text-primary"
                      : "shrink-0 text-muted-foreground"
                  }
                />
                <span
                  className={`min-w-0 flex-1 truncate text-caption font-medium ${newWorktreeStaged ? "text-primary" : "text-fg"}`}
                >
                  New worktree
                </span>
              </span>
              <span className="min-w-0 truncate text-caption text-faint">
                {newWorktreeStaged ? "named on send" : "off the main checkout"}
              </span>
            </button>
          ) : null}
          {mainWorktrees.map((worktree) => (
            <WorktreeCard
              key={worktree.id}
              worktree={worktree}
              selected={worktree.id === selectedWorktreeId}
              dot={worktreeDot(worktree.projectId)}
              projectName={projectName(worktree.projectId)}
              onSelect={() =>
                onSelectWorktree(
                  worktree.id === selectedWorktreeId ? null : worktree.id,
                )
              }
            />
          ))}
          {showWorktreeDivider ? (
            <div
              aria-hidden
              className="my-1 w-px shrink-0 self-stretch bg-line"
            />
          ) : null}
          {otherWorktrees.map((worktree) => (
            <WorktreeCard
              key={worktree.id}
              worktree={worktree}
              selected={worktree.id === selectedWorktreeId}
              dot={worktreeDot(worktree.projectId)}
              projectName={projectName(worktree.projectId)}
              onSelect={() =>
                onSelectWorktree(
                  worktree.id === selectedWorktreeId ? null : worktree.id,
                )
              }
            />
          ))}
          {activeWorktrees.length > 0 &&
          totalActiveWorktrees > activeWorktrees.length ? (
            <button
              type="button"
              onClick={onOpenPicker}
              title="More worktrees to select — open the full picker"
              className={`flex min-w-[5.5rem] shrink-0 snap-start flex-col items-center justify-center gap-1 rounded-xl border ${DASHED_EDGE} border-line px-3 py-2.5 text-muted-foreground transition-colors hover:border-line-strong hover:bg-raised hover:text-fg`}
            >
              <Ellipsis size={14} />
              <span className="text-caption font-medium">More…</span>
            </button>
          ) : null}
        </QuickRow>
      )}

      {/* Runtime block (who runs it and how) below the context rows, visually
          separated from the project/worktree staging above. */}
      <hr className="mx-4 border-line" />

      {agentPills && modePills ? (
        <QuickRowSplit
          groups={[
            { label: "Agent", children: agentPills },
            { label: "Mode", children: modePills },
          ]}
        />
      ) : agentPills ? (
        <QuickRow
          label="Agent"
          scrollKey={`${selectedAgentType}:${agentTypes.length}`}
        >
          {agentPills}
        </QuickRow>
      ) : modePills ? (
        // Two pills; nothing to scroll into view.
        <QuickRow label="Mode">{modePills}</QuickRow>
      ) : null}

      {credentialProfilesError ? (
        <div className="px-4">
          <ErrorNote
            message={`${
              credentialProfilesLoaded
                ? "Could not refresh credential profiles"
                : "Credential profiles are unavailable"
            }: ${credentialProfilesError}`}
            onRetry={onRetryCredentialProfiles}
          />
        </div>
      ) : null}

      {!credentialProfilesLoaded ? (
        <div
          role="status"
          aria-label="Loading credential profiles and models"
          className="flex flex-col gap-4"
        >
          <QuickRow label="Provider account" busy>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                aria-hidden
                className="h-9 w-28 shrink-0 snap-start rounded-xl border border-line bg-panel"
              >
                <Skeleton className="m-2.5 h-4" />
              </div>
            ))}
          </QuickRow>
          <QuickRow label="Model" busy>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                aria-hidden
                className="h-9 w-32 shrink-0 snap-start rounded-xl border border-line bg-panel"
              >
                <Skeleton className="m-2.5 h-4" />
              </div>
            ))}
          </QuickRow>
          <div className="w-full">
            <div className="mb-1.5 px-4 text-center text-caption font-medium uppercase tracking-wide text-faint">
              Thinking
            </div>
            <Skeleton className="mx-4 h-5 rounded-full" />
          </div>
        </div>
      ) : (
        <>
          {orderedCredentialProfiles.length > 0 ? (
            <ProviderAccountRow
              accounts={orderedCredentialProfiles.map((profile) => ({
                id: profile.id,
                name: profile.name,
                provider: profile.provider,
              }))}
              selectedId={selectedCredentialProfileId}
              usageIndicators={usageIndicators}
              onSelect={onSelectCredentialProfile}
            />
          ) : null}

          {models.length > 1 ? (
            <ModelQuickRow
              models={models}
              selected={selectedModel}
              onSelect={onSelectModel}
            />
          ) : null}

          {thinkingLevels.length > 1 ? (
            <div className="w-full">
              <div className="mb-1.5 px-4 text-center text-caption font-medium uppercase tracking-wide text-faint">
                Thinking
              </div>
              <ThinkingSlider
                levels={thinkingLevels}
                value={thinkingLevel}
                onChange={onSelectThinking}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
