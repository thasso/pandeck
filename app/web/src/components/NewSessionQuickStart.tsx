import {
  FolderKanban,
  GitBranch,
  House,
  Plus,
  UserRoundCog,
} from "lucide-react";
import {
  supportedThinkingLevelsForModel,
  type ModelOption,
  type ProjectRecord,
  type AgentType,
  type SessionListItem,
  type TaskSummary,
  type ThinkingLevel,
  type WorktreeRecord,
  type CredentialProfileSummary,
  accountProviderForModelProvider,
  agentRuntimeOf,
  type EntryLibraryList,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import { projectColor } from "../lib/projectDisplay.ts";
import { orderCredentialProfilesByProvider } from "../lib/credentialProfiles.ts";
import {
  EmptyBox,
  ErrorNote,
  RefreshIndicator,
  Skeleton,
} from "./common/load.tsx";
import {
  dataOf,
  errorOf,
  isInitialLoad,
  isPending,
  type LoadState,
} from "../lib/loadState.ts";
import { Item } from "./ui/item.tsx";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group.tsx";
import {
  ModelQuickRow,
  ProviderAccountRow,
  QUICK_CARD,
  QuickPill,
  QuickRow,
  ThinkingSlider,
} from "./common/RuntimePicker.tsx";
import { AGENT_TYPE_DISPLAY } from "./agentTypeDisplay.ts";
import { Card } from "./ui/card.tsx";
import { Label } from "./ui/label.tsx";
import { Switch } from "./ui/switch.tsx";
import { THINKING_LABELS } from "./common/ModelThinkingSelect.tsx";

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

/** One worktree card in the "Worktree" row. */
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
    <QuickPill
      selected={selected}
      title={selected ? `Remove worktree ${label}` : `Start in ${label}`}
      onClick={onSelect}
      className={`min-w-40 ${QUICK_CARD}`}
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
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 font-normal">
        <FolderKanban
          aria-hidden
          className="size-3 shrink-0"
          style={{ color: dot }}
        />
        <span className="min-w-0 truncate text-muted-foreground">
          {projectName}
        </span>
      </span>
    </QuickPill>
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
  selectedCredentialProfileId = null,
  onSelectCredentialProfile = () => {},
  automaticAccountName,
  requiresEnterprise = false,
  onRequiresEnterpriseChange = () => {},
  usageIndicators = null,
  agentTypes,
  selectedAgentType,
  onSelectAgentType,
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
  models,
  selectedModel,
  onSelectModel,
  thinkingLevel,
  onSelectThinking,
  agents,
  selectedAgent = null,
  onSelectAgent = () => {},
}: {
  credentialProfiles?: CredentialProfileSummary[];
  /** Whether the account/model projection has data (including shell-cached data). */
  credentialProfilesLoaded?: boolean;
  /** A first-load or refresh failure; loaded rows stay mounted underneath it. */
  credentialProfilesError?: string | undefined;
  onRetryCredentialProfiles?: () => void;
  /** The explicit account, or null for Automatic (the server picks at start). */
  selectedCredentialProfileId?: string | null;
  onSelectCredentialProfile?: (profileId: string | null) => void;
  /**
   * The account the server's router would pick for Automatic right now, when
   * it has said; a preview only, the first send picks again.
   */
  automaticAccountName?: string | undefined;
  /**
   * The session may run only on enterprise accounts — at start and on every
   * later switch. Only enterprise accounts are offered while it is on.
   */
  requiresEnterprise?: boolean;
  onRequiresEnterpriseChange?: (requiresEnterprise: boolean) => void;
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
  /** Picker model options; the row mirrors the composer's model picker. */
  models: ModelOption[];
  selectedModel: ModelOption | undefined;
  onSelectModel: (model: ModelOption) => void;
  thinkingLevel: ThinkingLevel;
  onSelectThinking: (level: ThinkingLevel) => void;
  /**
   * The agent definitions library (`docs/agent-definitions.md`): picking one
   * stages its persona, model and effort, and the session starts as that
   * agent. The row reserves its place while the first read is out and keeps
   * its pills through a rescan; an authoritatively empty library has no row.
   */
  agents?: LoadState<EntryLibraryList> | undefined;
  selectedAgent?: string | null;
  onSelectAgent?: (name: string | null) => void;
}) {
  // The row is the whole choice (no "More…" picker behind it): every active
  // worktree, narrowed to the staged project once one is picked — beside that
  // project's "New worktree". Each card still names its project.
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
  const offeredCredentialProfiles = requiresEnterprise
    ? orderedCredentialProfiles.filter((profile) => profile.enterprise)
    : orderedCredentialProfiles;

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
  return (
    // One card around the whole configuration: what the session starts in
    // and what runs it read as one object above the composer. It sits in the
    // composer's column (`max-w-3xl px-4`), so the two are the same width and
    // a phone keeps the same side inset. The rows keep their own inner
    // gutter, which is the card's padding.
    <div className="mt-6 w-full max-w-3xl px-4">
      <Card className="new-session-quick-start w-full bg-transparent">
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
                    selected
                      ? `Remove project ${p.name}`
                      : `Narrow to ${p.name}`
                  }
                  onClick={() => onSelectProject(selected ? null : p.id)}
                >
                  <FolderKanban
                    aria-hidden
                    className="size-3.5 shrink-0"
                    style={{ color: projectColor(p).dot }}
                  />
                  <span className="min-w-0 truncate">{p.name}</span>
                </QuickPill>
              );
            })}
          </QuickRow>
        ) : null}

        {!worktreesLoaded ? (
          <QuickRow label="Worktree" busy>
            {[0, 1, 2].map((i) => (
              <Item
                key={i}
                variant="outline"
                aria-hidden
                className="min-w-40 max-w-52 shrink-0 snap-start flex-col items-start gap-1 text-left"
              >
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16" />
              </Item>
            ))}
          </QuickRow>
        ) : (
          <QuickRow
            label="Worktree"
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
              <QuickPill
                selected={newWorktreeStaged}
                title={
                  newWorktreeStaged
                    ? "Don't create a worktree"
                    : `Create a worktree in ${projectName(selectedProjectId)} when you send`
                }
                onClick={() => onSelectNewWorktree(!newWorktreeStaged)}
                // The one card that makes something rather than picks it, said
                // by its + glyph: a dashed edge means an empty state here.
                className={`min-w-40 ${QUICK_CARD}`}
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
                  <span className="min-w-0 flex-1 truncate">New worktree</span>
                </span>
                <span className="min-w-0 truncate font-normal text-muted-foreground">
                  {/* The same line in both states, so selecting never resizes
                      the card. */}
                  off the main checkout
                </span>
              </QuickPill>
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
          </QuickRow>
        )}

        {/* Runtime block (who runs it and how) below the context rows, visually
          separated from the project/worktree staging above. */}
        <hr className="mx-4 border-border" />

        <AgentDefinitionRow
          state={agents}
          accounts={credentialProfilesLoaded ? credentialProfiles : undefined}
          selectedAgent={selectedAgent}
          onSelectAgent={onSelectAgent}
        />

        {/* Build/Plan is the composer's Plan switch, not a row here. */}
        {agentPills ? (
          <QuickRow
            label="Agent"
            scrollKey={`${selectedAgentType}:${agentTypes.length}`}
          >
            {agentPills}
          </QuickRow>
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
                <Skeleton
                  key={index}
                  className="h-8 w-32 shrink-0 snap-start"
                />
              ))}
            </QuickRow>
            <div className="w-full">
              <div className="mb-1.5 px-4 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Thinking
              </div>
              <div className="mx-auto w-full max-w-sm px-4">
                <Skeleton className="h-10" />
              </div>
            </div>
          </div>
        ) : (
          <>
            {orderedCredentialProfiles.length > 0 ? (
              <div className="flex flex-col gap-2">
                <ProviderAccountRow
                  accounts={offeredCredentialProfiles.map((profile) => ({
                    id: profile.id,
                    name: profile.name,
                    provider: profile.provider,
                  }))}
                  selectedId={selectedCredentialProfileId ?? undefined}
                  usageIndicators={usageIndicators}
                  onSelect={onSelectCredentialProfile}
                  automatic={{
                    selected: selectedCredentialProfileId === null,
                    onSelect: () => onSelectCredentialProfile(null),
                    detail: automaticAccountName
                      ? `Now: ${automaticAccountName}`
                      : requiresEnterprise
                        ? "Best enterprise account with room"
                        : "Best account with room",
                  }}
                />
                <div className="flex items-center justify-center gap-2 px-4">
                  <Switch
                    id="new-session-requires-enterprise"
                    size="sm"
                    checked={requiresEnterprise}
                    onCheckedChange={onRequiresEnterpriseChange}
                  />
                  <Label
                    htmlFor="new-session-requires-enterprise"
                    className="text-xs text-muted-foreground"
                  >
                    Requires enterprise
                  </Label>
                </div>
                {requiresEnterprise &&
                offeredCredentialProfiles.length === 0 ? (
                  <p className="px-4 text-center text-xs text-muted-foreground">
                    No enabled account is marked Enterprise, so this session
                    cannot start. Mark one under Settings → Claude SDK or
                    OpenAI, or turn this off.
                  </p>
                ) : null}
              </div>
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
                {/* The level is part of the label, not a line under the slider. */}
                <div className="mb-1.5 px-4 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Thinking ·{" "}
                  <span className="text-foreground">
                    {THINKING_LABELS[thinkingLevel]}
                  </span>
                </div>
                <ThinkingSlider
                  levels={thinkingLevels}
                  value={thinkingLevel}
                  onChange={onSelectThinking}
                  showValue={false}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * The "Agent definition" row: one pill per definition, a definition that
 * cannot start disabled with its reason. Idle (nobody subscribed) draws
 * nothing; the first read reserves the row (R4); a rescan keeps the pills
 * with an indicator (R2); a failed read says so in place.
 */
function AgentDefinitionRow({
  state,
  accounts,
  selectedAgent,
  onSelectAgent,
}: {
  state: LoadState<EntryLibraryList> | undefined;
  /**
   * The enabled accounts, once known. A definition is staged on an account of
   * its model's provider, so none is offered before the accounts are read.
   */
  accounts: ReadonlyArray<{ provider: string }> | undefined;
  selectedAgent: string | null;
  onSelectAgent: (name: string | null) => void;
}) {
  if (!state || state.status === "idle") return null;
  const agents = dataOf(state);
  const error = errorOf(state);
  if (isInitialLoad(state))
    return (
      // The status wraps the row: a listbox holds only its options.
      <div role="status" aria-label="Loading agent definitions">
        <QuickRow label="Agent definition" busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-8 w-28 shrink-0 snap-start" />
          ))}
        </QuickRow>
      </div>
    );
  if (!agents)
    return error ? (
      <div className="px-4">
        <ErrorNote message={error} />
      </div>
    ) : null;
  // An authoritatively empty library has nothing to offer: no row.
  if (agents.entries.length === 0 && !error) return null;
  // Why each definition cannot start here, if it cannot: the server's reason,
  // or no enabled account of its model's provider. Each names its definition,
  // so two alike still say which pill they explain.
  const problemOf = (name: string): string | undefined => {
    const runtime = agentRuntimeOf(agents, name);
    if (runtime?.problem !== undefined) return runtime.problem;
    if (runtime && accounts && !hasAccountFor(accounts, runtime.provider))
      return `Agent "${name}" cannot start here: no enabled account runs ${runtime.provider} models.`;
    return undefined;
  };
  const problems = agents.entries.flatMap((agent) => {
    const problem = problemOf(agent.name);
    return problem === undefined ? [] : [{ name: agent.name, problem }];
  });
  return (
    <>
      <QuickRow
        label="Agent definition"
        scrollKey={`${selectedAgent ?? ""}:${agents.entries.length}`}
      >
        {agents.entries.map((agent) => {
          const runtime = agentRuntimeOf(agents, agent.name);
          const problem = problemOf(agent.name);
          const selected = agent.name === selectedAgent;
          return (
            <QuickPill
              key={agent.name}
              selected={selected}
              // A definition that cannot start is not offered; the picked one
              // stays clickable so it can always be unpicked.
              disabled={
                !selected &&
                (problem !== undefined ||
                  runtime === undefined ||
                  accounts === undefined)
              }
              title={
                problem ??
                (selected
                  ? `Start as a plain session instead of ${agent.name}`
                  : `Start as ${agent.name}: ${agent.description}`)
              }
              onClick={() => onSelectAgent(selected ? null : agent.name)}
            >
              <UserRoundCog aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{agent.name}</span>
            </QuickPill>
          );
        })}
      </QuickRow>
      {/* Outside the listbox, and where a long row cannot scroll it away. */}
      {isPending(state) ? (
        <div className="flex justify-center px-4">
          <RefreshIndicator label="Rescanning agents" />
        </div>
      ) : null}
      {/* Why a definition cannot start, where touch and keyboard users see
          it too: a disabled pill's title never shows. */}
      {problems.length > 0 ? (
        <ul className="px-4 text-sm text-muted-foreground">
          {problems.map(({ name, problem }) => (
            <li key={name}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <div className="px-4">
          <ErrorNote message={error} />
        </div>
      ) : null}
    </>
  );
}

/** Whether an enabled account can run a model of this provider. */
function hasAccountFor(
  accounts: ReadonlyArray<{ provider: string }>,
  modelProvider: string,
): boolean {
  const provider = accountProviderForModelProvider(modelProvider);
  return accounts.some((account) => account.provider === provider);
}
