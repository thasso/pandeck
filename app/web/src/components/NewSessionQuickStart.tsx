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
import { EmptyBox, ErrorNote, Skeleton } from "./common/load.tsx";
import { Button } from "./ui/button.tsx";
import { Item } from "./ui/item.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import {
  ModelQuickRow,
  ProviderAccountRow,
  QuickPill,
  QuickRow,
  QuickRowSplit,
  ThinkingSlider,
} from "./common/RuntimePicker.tsx";
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
    <Item
      render={<button type="button" />}
      variant={selected ? "muted" : "outline"}
      role="option"
      aria-selected={selected}
      data-quick-selected={selected || undefined}
      title={selected ? `Remove worktree ${label}` : `Start in ${label}`}
      onClick={onSelect}
      className="min-w-40 max-w-52 shrink-0 snap-start flex-col items-start gap-1"
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
          className={`min-w-0 flex-1 truncate text-sm font-medium ${selected ? "text-primary" : "text-foreground"}`}
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
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {projectName}
        </span>
      </span>
    </Item>
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
    agentTypes.length > 1 ? (
      <ToggleGroup
        variant="outline"
        value={[selectedAgentType]}
        onValueChange={(values) => {
          const next = values[0] as AgentType | undefined;
          if (next) onSelectAgentType(next);
        }}
      >
        {agentTypes.map((type) => {
          const display = AGENT_TYPE_DISPLAY[type];
          const selected = type === selectedAgentType;
          return (
            <ToggleGroupItem
              key={type}
              value={type}
              role="option"
              aria-selected={selected}
              title={display.desc}
            >
              <display.Icon
                size={14}
                className={selected ? display.activeColor : display.pillColor}
              />
              <span className="min-w-0 truncate">{display.label}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    ) : null;
  const pickMode = onSelectMode;
  const modePills =
    mode && pickMode ? (
      <ToggleGroup
        variant="outline"
        value={[mode]}
        onValueChange={(values) => {
          const next = values[0] as SessionMode | undefined;
          if (next) pickMode(next);
        }}
      >
        {MODE_OPTIONS.map((option) => {
          const selected = option.value === mode;
          return (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              role="option"
              aria-selected={selected}
              title={option.title}
            >
              <option.Icon
                size={14}
                className={selected ? "text-primary" : "text-muted-foreground"}
              />
              <span className="min-w-0 truncate">{option.label}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    ) : null;

  return (
    <div className="new-session-quick-start mt-6 flex w-full max-w-2xl flex-col gap-4">
      {!projectsLoaded ? (
        <QuickRow label="Project" busy>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-28 shrink-0 snap-start" />
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
            <Item
              key={i}
              variant="outline"
              aria-hidden
              className="min-w-40 max-w-52 shrink-0 snap-start flex-col items-start gap-1"
            >
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-16" />
            </Item>
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
                <GitBranch
                  size={13}
                  className="shrink-0 text-muted-foreground"
                />
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
            <Item
              render={<button type="button" />}
              variant={newWorktreeStaged ? "muted" : "outline"}
              role="option"
              aria-selected={newWorktreeStaged}
              data-quick-selected={newWorktreeStaged || undefined}
              title={
                newWorktreeStaged
                  ? "Don't create a worktree"
                  : `Create a worktree in ${projectName(selectedProjectId)} when you send`
              }
              onClick={() => onSelectNewWorktree(!newWorktreeStaged)}
              className="min-w-40 max-w-52 shrink-0 snap-start flex-col items-start gap-1"
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
                  className={`min-w-0 flex-1 truncate text-sm font-medium ${newWorktreeStaged ? "text-primary" : "text-foreground"}`}
                >
                  New worktree
                </span>
              </span>
              <span className="min-w-0 truncate text-sm text-muted-foreground">
                {newWorktreeStaged ? "named on send" : "off the main checkout"}
              </span>
            </Item>
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
              className="my-1 w-px shrink-0 self-stretch bg-border"
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
            <Button
              variant="outline"
              onClick={onOpenPicker}
              title="More worktrees to select — open the full picker"
              className="h-auto min-w-24 shrink-0 snap-start flex-col"
            >
              <Ellipsis size={14} />
              <span>More…</span>
            </Button>
          ) : null}
        </QuickRow>
      )}

      {/* Runtime block (who runs it and how) below the context rows, visually
          separated from the project/worktree staging above. */}
      <hr className="mx-4 border-border" />

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
              <Item
                key={index}
                variant="outline"
                aria-hidden
                className="h-20 w-52 shrink-0 snap-start flex-col items-start gap-1"
              >
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-3 w-36" />
              </Item>
            ))}
          </QuickRow>
          <QuickRow label="Model" busy>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-8 w-32 shrink-0 snap-start" />
            ))}
          </QuickRow>
          <div className="w-full">
            <div className="mb-1.5 px-4 text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Thinking
            </div>
            <div className="mx-auto w-full max-w-sm px-4">
              <Skeleton className="h-10" />
              <Skeleton className="mx-auto mt-0.5 h-5 w-12" />
            </div>
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
              <div className="mb-1.5 px-4 text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
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
