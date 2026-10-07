import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  type AccountModelOption,
  accountProviderForModelProvider,
  applyWorkflowRunLimits,
  clampThinkingLevelForModel,
  CLAUDE_SDK_PROVIDER,
  type CodeDeliveryWorkflowConfig,
  defaultWorkflowRunLimits,
  modelKey,
  normalizeWorkflowRunLimits,
  supportedThinkingLevelsForModel,
  type TaskSummary,
  type ThinkingLevel,
  WORKFLOW_CI_DEFAULTS,
  WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS,
  WORKFLOW_ROLE_FAMILY_MAX_CHARS,
  WORKFLOW_ROLE_NOTES_MAX_CHARS,
  WORKFLOW_ROLE_SET_BOUNDS,
  WORKFLOW_RUN_LIMIT_BOUNDS,
  type WorkflowCandidateRole,
  type WorkflowRoleCandidate,
  type WorkflowRoleConfig,
  type WorkflowRunLimits,
  type WorkflowRunStartPhase,
  type WorktreeRecord,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import type { Prefs } from "../hooks/usePrefs.ts";
import { carryOverRuntimeSelection } from "../lib/newSessionRuntime.ts";
import { useMobileLayout } from "./shell/useMobileLayout.ts";
import { showToast } from "../lib/toast.ts";
import { workflowStartOutcomeToast } from "../lib/workflowStart.ts";
import { IconButton } from "./common/IconButton.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ErrorNote, Spinner } from "./common/load.tsx";
import { THINKING_LABELS } from "./common/ModelThinkingSelect.tsx";
import {
  DiscreteSlider,
  ModelQuickRow,
  ProviderAccountRow,
  ThinkingSlider,
  type RuntimeAccount,
} from "./common/RuntimePicker.tsx";
import { TaskIdBadge } from "./TaskIdBadge.tsx";

/** The separately chosen coordinator and four role-scoped candidate sets. */
export interface WorkflowStartRoles {
  coordinator: WorkflowStartRoleState;
  sets: Record<WorkflowCandidateRole, WorkflowStartRoleState[]>;
}

/** Which row a control addresses: the coordinator row, or one role candidate. */
type WorkflowRow = "coordinator" | `${WorkflowCandidateRole}:${number}`;

const CANDIDATE_ROLES: readonly WorkflowCandidateRole[] = [
  "implementer",
  "reviewer",
  "fixer",
  "verdict",
];

const CONFIGURATION_LETTERS = "ABCDEF";

const COORDINATOR_LABEL = "Coordinator";
const COORDINATOR_HINT =
  "Cheap, worktree-free model that plans the run and decides after each review whether another is warranted.";

/** The label of one candidate row within a role set. */
export function configurationLabel(
  role: WorkflowCandidateRole,
  index: number,
): string {
  return `${role[0]!.toUpperCase()}${role.slice(1)} configuration ${CONFIGURATION_LETTERS[index] ?? String(index + 1)}`;
}

export function configurationHint(role: WorkflowCandidateRole): string {
  if (role === "fixer")
    return "Chosen for revision rounds; an empty set falls back to the implementer.";
  if (role === "verdict")
    return "Judges whether a fix round resolved prior findings; an empty set skips this pass.";
  return `A candidate the coordinator may choose as ${role}.`;
}

export function canAddConfiguration(
  role: WorkflowCandidateRole,
  count: number,
): boolean {
  return count < WORKFLOW_ROLE_SET_BOUNDS[role].max;
}

export function canRemoveConfiguration(
  role: WorkflowCandidateRole,
  count: number,
): boolean {
  return count > WORKFLOW_ROLE_SET_BOUNDS[role].min;
}

/** The prompt overrides a run may carry, by the work role they apply to. */
const OVERRIDE_ROLES = ["implementer", "reviewer"] as const;
type WorkflowOverrideRole = (typeof OVERRIDE_ROLES)[number];
export type WorkflowPromptOverrides = Record<WorkflowOverrideRole, string>;

const OVERRIDE_LABEL: Record<WorkflowOverrideRole, string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
};

export type StoredRoleRuntimes = NonNullable<Prefs["workflowRoleRuntimes"]>;
type StoredRoleRuntime = StoredRoleRuntimes["roles"]["implementer"][number];

/**
 * The model + thinking level a role's controls open with: the remembered
 * last-started pair when it still resolves against the offered account models,
 * else the first offered model. Each role falls back on its own, so one
 * disappeared account or model does not reset the others. Exported for tests —
 * this is what makes the common path a one-tap start.
 */
export function defaultRoleSelection(
  models: readonly AccountModelOption[],
  stored: StoredRoleRuntime | undefined,
): WorkflowStartRoleState {
  const remembered = stored
    ? models.find(
        (candidate) =>
          modelKey(candidate) === stored.modelKey &&
          (!stored.credentialProfileId ||
            candidate.credentialProfileId === stored.credentialProfileId),
      )
    : undefined;
  const model = remembered ?? models[0];
  return {
    model,
    thinkingLevel: clampThinkingLevelForModel(
      model,
      stored?.thinkingLevel ?? "medium",
    ),
    family:
      remembered && stored?.family !== undefined
        ? stored.family
        : familyForModel(model),
    notes: stored?.notes ?? "",
  };
}

/** Prefer an explicitly cheap offered model for the worktree-free coordinator. */
function defaultCoordinatorSelection(
  models: readonly AccountModelOption[],
  stored: StoredRoleRuntime | undefined,
): WorkflowStartRoleState {
  if (stored) return defaultRoleSelection(models, stored);
  const cheap = models.find((candidate) =>
    /haiku|mini|flash|small/i.test(`${candidate.id} ${candidate.name}`),
  );
  const model = cheap ?? models[0];
  return {
    model,
    thinkingLevel: clampThinkingLevelForModel(model, "low"),
    family: familyForModel(model),
    notes: "",
  };
}

/**
 * Every row's opening selection, restored independently per role set and
 * clamped into today's bounds.
 * Exported for tests.
 */
export function initialRoleStates(
  models: readonly AccountModelOption[],
  stored: Prefs["workflowRoleRuntimes"],
): WorkflowStartRoles {
  const initialSet = (role: WorkflowCandidateRole) => {
    const remembered = (stored?.roles[role] ?? []).slice(
      0,
      WORKFLOW_ROLE_SET_BOUNDS[role].max,
    );
    const defaults =
      role === "implementer" || role === "reviewer" ? [undefined] : [];
    return (remembered.length > 0 ? remembered : defaults).map((candidate) =>
      defaultRoleSelection(models, candidate),
    );
  };
  return {
    coordinator: defaultCoordinatorSelection(models, stored?.coordinator),
    sets: {
      implementer: initialSet("implementer"),
      reviewer: initialSet("reviewer"),
      fixer: initialSet("fixer"),
      verdict: initialSet("verdict"),
    },
  };
}

/** What the sheet remembers when a run is STARTED (never when it is cancelled). */
export function rememberedRuntimes(
  roles: WorkflowStartRoles,
): StoredRoleRuntimes {
  const entryOf = (
    state: WorkflowStartRoleState,
  ): StoredRoleRuntime | undefined =>
    state.model
      ? {
          modelKey: modelKey(state.model),
          credentialProfileId: state.model.credentialProfileId,
          thinkingLevel: state.thinkingLevel,
          ...(state.family.trim() ? { family: state.family.trim() } : {}),
          ...(state.notes.trim() ? { notes: state.notes.trim() } : {}),
        }
      : undefined;
  const coordinator = entryOf(roles.coordinator);
  return {
    ...(coordinator ? { coordinator } : {}),
    roles: Object.fromEntries(
      CANDIDATE_ROLES.map((role) => [
        role,
        roles.sets[role]
          .map(entryOf)
          .filter((entry): entry is StoredRoleRuntime => Boolean(entry)),
      ]),
    ) as StoredRoleRuntimes["roles"],
  };
}

/** One role's sheet state folded into the wire config. Exported for tests. */
function workflowRoleConfigOf(
  model: AccountModelOption,
  thinkingLevel: ThinkingLevel,
  promptOverride: string,
): WorkflowRoleConfig {
  const override = promptOverride.trim();
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: clampThinkingLevelForModel(model, thinkingLevel),
    credentialProfileId: model.credentialProfileId,
    ...(override ? { promptOverride: override } : {}),
  };
}

function workflowCandidateConfigOf(
  state: WorkflowStartRoleState,
): WorkflowRoleCandidate | undefined {
  if (!state.model || !state.family.trim()) return undefined;
  return {
    ...workflowRoleConfigOf(state.model, state.thinkingLevel, ""),
    family: state.family.trim(),
    ...(state.notes.trim() ? { notes: state.notes.trim() } : {}),
  };
}

/**
 * Whether the start surface may be DISMISSED (backdrop, Escape, X, Cancel).
 * Once starting is pending, no: the run and its worktree are already being
 * created, so the only honest exits are the outcome or the explicit
 * "Run in background" action — never a "Cancel" that cancels nothing.
 * Exported for tests.
 */
function canDismissWorkflowStart(pending: boolean): boolean {
  return !pending;
}

/** The one-line resting face of a runtime row: model, account, thinking. */
function familyForModel(model: AccountModelOption | undefined): string {
  if (!model) return "";
  if (model.provider === CLAUDE_SDK_PROVIDER) return "claude";
  if (model.provider === "openai-codex") return "gpt";
  return model.provider;
}

function roleSummary(state: WorkflowStartRoleState): string {
  if (!state.model) return "No model available";
  const thinking =
    state.thinkingLevel === "off"
      ? "no thinking"
      : `${THINKING_LABELS[state.thinkingLevel].toLowerCase()} thinking`;
  return `${state.model.name} · ${state.model.accountName} · ${thinking}`;
}

/** The provider accounts the offered models come from, in their offered order. */
function accountsOf(models: readonly AccountModelOption[]): RuntimeAccount[] {
  const accounts = new Map<string, RuntimeAccount>();
  for (const model of models) {
    if (accounts.has(model.credentialProfileId)) continue;
    accounts.set(model.credentialProfileId, {
      id: model.credentialProfileId,
      name: model.accountName,
      provider: accountProviderForModelProvider(model.provider),
    });
  }
  return [...accounts.values()];
}

const PHASE_LABEL: Record<Exclude<WorkflowRunStartPhase, "failed">, string> = {
  naming: "Naming the branch…",
  creating: "Creating the worktree…",
  submodules: "Fetching submodules…",
  started: "Started.",
};

export interface WorkflowStartRoleState {
  model: AccountModelOption | undefined;
  thinkingLevel: ThinkingLevel;
  family: string;
  notes: string;
}

export interface WorkflowCiSettings {
  earlyPush: boolean;
  timeoutSeconds: number;
  pollIntervalSeconds: number;
}

export type WorkflowBaseWorktree = Pick<
  WorktreeRecord,
  "id" | "projectId" | "isMain" | "branch" | "status"
> &
  Partial<Pick<WorktreeRecord, "taskIds">>;

export type WorkflowBaseTask = Pick<TaskSummary, "id" | "parentId">;

export interface WorkflowBaseBranchOption {
  branch: string;
  isMain: boolean;
}

/** Main first, then each distinct active spawned-worktree branch in the Project. */
export function workflowBaseBranchOptions(
  projectId: string | undefined,
  worktrees: readonly WorkflowBaseWorktree[],
): WorkflowBaseBranchOption[] {
  if (!projectId) return [];
  const projectWorktrees = worktrees.filter(
    (worktree) =>
      worktree.projectId === projectId && worktree.status === "active",
  );
  const main = projectWorktrees.find((worktree) => worktree.isMain);
  if (!main) return [];
  const seen = new Set([main.branch]);
  return [
    { branch: main.branch, isMain: true },
    ...projectWorktrees.flatMap((worktree) => {
      if (worktree.isMain || seen.has(worktree.branch)) return [];
      seen.add(worktree.branch);
      return [{ branch: worktree.branch, isMain: false }];
    }),
  ];
}

/**
 * The nearest ancestor's active spawned-worktree branch, if the Task is nested
 * under work already staged on its own branch. Cycles are guarded even though
 * the Task store rejects them: this helper consumes subscription data.
 */
export function preferredWorkflowBaseBranch(
  taskId: string,
  projectId: string | undefined,
  tasks: readonly WorkflowBaseTask[],
  worktrees: readonly WorkflowBaseWorktree[],
): string | undefined {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set([taskId]);
  let parentId = tasksById.get(taskId)?.parentId;
  while (parentId && !seen.has(parentId)) {
    const ancestorId = parentId;
    seen.add(ancestorId);
    const base = worktrees.find(
      (worktree) =>
        !worktree.isMain &&
        worktree.projectId === projectId &&
        worktree.status === "active" &&
        worktree.taskIds?.includes(ancestorId),
    );
    if (base) return base.branch;
    parentId = tasksById.get(ancestorId)?.parentId;
  }
  return undefined;
}

export interface WorkflowRunStartLayerProps {
  task: { id: string; title: string };
  models: AccountModelOption[];
  /**
   * Subscription-usage indicators from the server cache (`docs/usage.md`), or
   * null while the first snapshot has not arrived. Display-only here: the run's
   * coordinator never sees them.
   */
  usageIndicators?: UsageIndicator[] | null | undefined;
  roles: WorkflowStartRoles;
  limits: WorkflowRunLimits;
  baseBranches?: readonly WorkflowBaseBranchOption[];
  /** Undefined means the main checkout branch (the first option). */
  baseBranch?: string | undefined;
  onChangeBaseBranch?: (baseBranch: string | undefined) => void;
  /** Whether the displayed limits override complexity-sized defaults. */
  customLimits?: boolean;
  /** Per-RUN extra instructions; deliberately not remembered for the next Task. */
  overrides: WorkflowPromptOverrides;
  ciSettings?: WorkflowCiSettings;
  /** A start request is under way; the surface stops being dismissible. */
  pending: boolean;
  /** The pending request's current provisioning phase, when known. */
  phase?: WorkflowRunStartPhase | undefined;
  branch?: string | undefined;
  /** The failed request's error, shown inline with Start re-enabled. */
  error?: string | undefined;
  onChangeRole: (
    row: WorkflowRow,
    patch: Partial<WorkflowStartRoleState>,
  ) => void;
  /** Append a candidate to one role set, up to its maximum. */
  onAddConfiguration: (role: WorkflowCandidateRole) => void;
  /** Drop one candidate while preserving that role set's minimum. */
  onRemoveConfiguration: (role: WorkflowCandidateRole, index: number) => void;
  onChangeLimits: (patch: Partial<WorkflowRunLimits>) => void;
  onChangeCustomLimits?: (custom: boolean) => void;
  onChangeOverride: (role: WorkflowOverrideRole, text: string) => void;
  onChangeCiSettings?: (patch: Partial<WorkflowCiSettings>) => void;
  /** Put the whole form back to the recommended configuration. */
  onResetDefaults: () => void;
  onStart: () => void;
  onClose: () => void;
  /** Close the surface while the start keeps going; outcome arrives as a toast. */
  onContinueInBackground: () => void;
}

/**
 * @component WorkflowRunStartLayer
 * @purpose The whole start surface's content, portal-free so the DOM-less test
 * suite can render it; {@link WorkflowRunStartSheet} puts it in a full-screen
 * sheet on small screens and a dialog on wide ones. It rests as a compact CONFIGURATION SUMMARY
 * — one line per runtime — and expands exactly one runtime row at a time for
 * editing, so the whole run stays readable at a glance on a phone. While a
 * start is pending it is not dismissible ({@link canDismissWorkflowStart}); the
 * footer then offers only the truthful "Run in background".
 * @useWhen Rendered by {@link WorkflowRunStartSheet}; render directly in tests.
 */
export function WorkflowRunStartLayer({
  task,
  models,
  usageIndicators = null,
  roles,
  limits,
  baseBranches = [],
  baseBranch,
  onChangeBaseBranch = () => undefined,
  customLimits = false,
  overrides,
  ciSettings = {
    earlyPush: WORKFLOW_CI_DEFAULTS.enabled,
    timeoutSeconds: WORKFLOW_CI_DEFAULTS.timeoutMs / 1_000,
    pollIntervalSeconds: WORKFLOW_CI_DEFAULTS.pollIntervalMs / 1_000,
  },
  pending,
  phase,
  branch,
  error,
  onChangeRole,
  onAddConfiguration,
  onRemoveConfiguration,
  onChangeLimits,
  onChangeCustomLimits = () => undefined,
  onChangeOverride,
  onChangeCiSettings = () => undefined,
  onResetDefaults,
  onStart,
  onClose,
  onContinueInBackground,
}: WorkflowRunStartLayerProps) {
  // One row open at a time: a summary that expands, never a wizard. Removing a
  // configuration collapses the open row, since the row keys are positional and
  // a kept expansion would silently move to a different configuration.
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const accounts = useMemo(() => accountsOf(models), [models]);
  const ready =
    Boolean(roles.coordinator.model) &&
    CANDIDATE_ROLES.every((role) => {
      const set = roles.sets[role];
      const bounds = WORKFLOW_ROLE_SET_BOUNDS[role];
      return (
        set.length >= bounds.min &&
        set.length <= bounds.max &&
        set.every((candidate) => candidate.model && candidate.family.trim())
      );
    });
  const overrideCount = OVERRIDE_ROLES.filter((role) =>
    overrides[role].trim(),
  ).length;
  const defaultBaseBranch = baseBranches[0]?.branch;
  const effectiveBaseBranch = baseBranch ?? defaultBaseBranch;

  // The coordinator row, then the allowlist in order — one shape, so the
  // rows below render identically whether or not they can be removed.
  const rows: {
    key: string;
    row: WorkflowRow;
    label: string;
    hint: string;
    state: WorkflowStartRoleState;
    onRemove?: () => void;
  }[] = [
    {
      key: "coordinator",
      row: "coordinator",
      label: COORDINATOR_LABEL,
      hint: COORDINATOR_HINT,
      state: roles.coordinator,
    },
    ...CANDIDATE_ROLES.flatMap((role) =>
      roles.sets[role].map((state, index) => ({
        key: `${role}-${String(index)}`,
        row: `${role}:${String(index)}` as WorkflowRow,
        label: configurationLabel(role, index),
        hint: configurationHint(role),
        state,
        ...(canRemoveConfiguration(role, roles.sets[role].length)
          ? {
              onRemove: () => {
                setExpandedRow(null);
                onRemoveConfiguration(role, index);
              },
            }
          : {}),
      })),
    ),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Run workflow</h2>
          <div className="mt-0.5 flex items-center gap-2 text-muted-foreground">
            <TaskIdBadge id={task.id} />
            <span className="min-w-0 flex-1 truncate" title={task.title}>
              {task.title}
            </span>
          </div>
        </div>
        {canDismissWorkflowStart(pending) ? (
          <IconButton label="Close" onClick={onClose}>
            <X />
          </IconButton>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        <Field>
          <FieldLabel htmlFor="workflow-base-branch">Base branch</FieldLabel>
          {defaultBaseBranch ? (
            <NativeSelect
              id="workflow-base-branch"
              aria-label="Base branch"
              value={effectiveBaseBranch}
              disabled={pending}
              onChange={(event) =>
                onChangeBaseBranch(
                  event.target.value === defaultBaseBranch
                    ? undefined
                    : event.target.value,
                )
              }
            >
              {baseBranches.map((option) => (
                <NativeSelectOption key={option.branch} value={option.branch}>
                  {option.branch}
                  {option.isMain ? " (main checkout)" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <p className="text-muted-foreground">
              Main checkout branch (default)
            </p>
          )}
          <FieldDescription>
            This run only. Active worktree branches in the Task&apos;s Project
            can be selected as epic bases.
          </FieldDescription>
        </Field>

        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-muted-foreground">Runtimes</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onResetDefaults}
            disabled={pending}
            title="Put every runtime, limit and override back to the recommended run"
          >
            <RotateCcw />
            Reset to recommended defaults
          </Button>
        </div>

        {rows.map(({ key, row, label, hint, state, onRemove }) => {
          const open = expandedRow === key;
          const accountId = state.model?.credentialProfileId;
          const accountModels = models.filter(
            (candidate) => candidate.credentialProfileId === accountId,
          );
          const thinkingLevels = supportedThinkingLevelsForModel(state.model);
          return (
            <Collapsible
              key={key}
              open={open}
              onOpenChange={(next) => setExpandedRow(next ? key : null)}
              disabled={pending}
              className="rounded-lg border"
            >
              {/* The remove control is a SIBLING of the expander, never nested
                  inside it: one button may not contain another. */}
              <div className="flex items-center gap-1 p-1">
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="ghost"
                      className="h-auto min-w-0 flex-1 justify-start py-1.5 text-left"
                    />
                  }
                  title={open ? `Collapse ${label}` : hint}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block">{label}</span>
                    <span className="block truncate font-normal text-muted-foreground">
                      {roleSummary(state)}
                    </span>
                  </span>
                  <ChevronDown className={open ? "rotate-180" : ""} />
                </CollapsibleTrigger>
                {onRemove ? (
                  <IconButton
                    label={`Remove ${label}`}
                    onClick={onRemove}
                    disabled={pending}
                  >
                    <Trash2 />
                  </IconButton>
                ) : null}
              </div>
              <CollapsibleContent>
                <div className="flex flex-col gap-3 border-t py-3">
                  <p className="px-3 text-muted-foreground">{hint}</p>
                  {accounts.length > 0 ? (
                    <ProviderAccountRow
                      accounts={accounts}
                      selectedId={accountId}
                      usageIndicators={usageIndicators}
                      disabled={pending}
                      onSelect={(nextAccountId) => {
                        if (nextAccountId === accountId) return;
                        const next = carryOverRuntimeSelection({
                          model: state.model,
                          thinkingLevel: state.thinkingLevel,
                          fromModels: accountModels,
                          toModels: models.filter(
                            (candidate) =>
                              candidate.credentialProfileId === nextAccountId,
                          ),
                        });
                        onChangeRole(row, {
                          ...next,
                          family: familyForModel(next.model),
                        });
                      }}
                    />
                  ) : null}
                  <ModelQuickRow
                    models={accountModels}
                    selected={state.model}
                    disabled={pending}
                    onSelect={(model) =>
                      onChangeRole(row, {
                        model,
                        thinkingLevel: clampThinkingLevelForModel(
                          model,
                          state.thinkingLevel,
                        ),
                        family: familyForModel(model),
                      })
                    }
                  />
                  {thinkingLevels.length > 1 ? (
                    <div className="w-full">
                      <p className="mb-1.5 px-4 text-center font-medium text-muted-foreground">
                        Thinking
                      </p>
                      <ThinkingSlider
                        levels={thinkingLevels}
                        value={state.thinkingLevel}
                        disabled={pending}
                        onChange={(thinkingLevel) =>
                          onChangeRole(row, { thinkingLevel })
                        }
                      />
                    </div>
                  ) : null}
                  {row !== "coordinator" ? (
                    <div className="grid gap-3 px-3 sm:grid-cols-2">
                      <Field>
                        <FieldLabel htmlFor={`workflow-family-${key}`}>
                          Model family
                        </FieldLabel>
                        <Input
                          id={`workflow-family-${key}`}
                          value={state.family}
                          maxLength={WORKFLOW_ROLE_FAMILY_MAX_CHARS}
                          disabled={pending}
                          onChange={(event) =>
                            onChangeRole(row, { family: event.target.value })
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`workflow-notes-${key}`}>
                          Selection notes (optional)
                        </FieldLabel>
                        <Input
                          id={`workflow-notes-${key}`}
                          value={state.notes}
                          maxLength={WORKFLOW_ROLE_NOTES_MAX_CHARS}
                          disabled={pending}
                          onChange={(event) =>
                            onChangeRole(row, { notes: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}

        <div className="grid grid-cols-2 gap-2">
          {CANDIDATE_ROLES.map((role) => (
            <Button
              key={role}
              variant="outline"
              onClick={() => onAddConfiguration(role)}
              disabled={
                pending || !canAddConfiguration(role, roles.sets[role].length)
              }
              title={`Add a candidate to the ${role} role set`}
            >
              <Plus />
              Add {role} configuration
            </Button>
          ))}
        </div>

        <p className="text-muted-foreground">
          Implementer and reviewer require at least one candidate. Empty fixer
          falls back to the implementer; empty verdict skips post-fix judgment.
        </p>

        {/* Every one of these is a CEILING the run stops at; each hint says who
            decides the actual number. */}
        <FieldSet className="rounded-lg border p-3">
          <FieldLegend>Upper limits</FieldLegend>
          <FieldDescription>
            Ceilings, not targets: the run uses what the work needs and stops
            here.
          </FieldDescription>
          <CheckboxField
            id="workflow-custom-limits"
            checked={customLimits}
            disabled={pending}
            onChange={onChangeCustomLimits}
          >
            Set ceilings myself. Otherwise the coordinator's low, medium, or
            high complexity plan sizes both ceilings before implementation.
          </CheckboxField>
          {customLimits ? (
            <>
              <LimitSlider
                label="Max revision rounds"
                bounds={WORKFLOW_RUN_LIMIT_BOUNDS.maxIterations}
                value={limits.maxIterations}
                unit={limits.maxIterations === 1 ? "round" : "rounds"}
                hint={`The reviewer sends work back as often as it judges necessary; after ${String(
                  limits.maxIterations,
                )} ${limits.maxIterations === 1 ? "round" : "rounds"} the run asks you whether to allow more.`}
                disabled={pending}
                onChange={(maxIterations) => onChangeLimits({ maxIterations })}
              />
              <LimitSlider
                label="Max review passes"
                bounds={WORKFLOW_RUN_LIMIT_BOUNDS.maxReviewPasses}
                value={limits.maxReviewPasses}
                unit={limits.maxReviewPasses === 1 ? "pass" : "passes"}
                hint={
                  limits.maxReviewPasses === 1
                    ? "The work is reviewed once before it may be delivered."
                    : `The work is reviewed at least once; after each review the coordinator decides whether another is warranted, up to ${String(
                        limits.maxReviewPasses,
                      )} passes. The run opens the sessions those passes need — there is nothing else to size.`
                }
                disabled={pending}
                onChange={(maxReviewPasses) =>
                  onChangeLimits({ maxReviewPasses })
                }
              />
            </>
          ) : null}
        </FieldSet>

        <Advanced title="Advanced: CI machine verification">
          <CheckboxField
            id="workflow-early-push"
            checked={ciSettings.earlyPush}
            disabled={pending}
            onChange={(earlyPush) => onChangeCiSettings({ earlyPush })}
          >
            Push each exact review commit and open one draft pull request.
            Disable this for local/no-remote runs; delivery will create the PR
            after review instead.
          </CheckboxField>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="workflow-ci-timeout">
                CI timeout (seconds)
              </FieldLabel>
              <Input
                id="workflow-ci-timeout"
                type="number"
                min={30}
                max={1_800}
                value={ciSettings.timeoutSeconds}
                disabled={pending || !ciSettings.earlyPush}
                onChange={(event) =>
                  onChangeCiSettings({
                    timeoutSeconds: Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="workflow-ci-poll">
                Poll interval (seconds)
              </FieldLabel>
              <Input
                id="workflow-ci-poll"
                type="number"
                min={1}
                max={60}
                value={ciSettings.pollIntervalSeconds}
                disabled={pending || !ciSettings.earlyPush}
                onChange={(event) =>
                  onChangeCiSettings({
                    pollIntervalSeconds: Number(event.target.value),
                  })
                }
              />
            </Field>
          </div>
        </Advanced>

        <Advanced
          title="Advanced: prompt overrides"
          badge={
            overrideCount > 0
              ? overrideCount === 1
                ? "1 override"
                : "2 overrides"
              : undefined
          }
        >
          <p className="text-muted-foreground">
            These apply to this run only — the next Task starts without them, so
            instructions for one Task cannot leak into unrelated work.
          </p>
          {OVERRIDE_ROLES.map((role) => (
            <Field key={role}>
              <FieldLabel htmlFor={`workflow-override-${role}`}>
                {OVERRIDE_LABEL[role]} instructions (optional)
              </FieldLabel>
              <Textarea
                id={`workflow-override-${role}`}
                value={overrides[role]}
                maxLength={WORKFLOW_PROMPT_OVERRIDE_MAX_CHARS}
                disabled={pending}
                placeholder={`Extra instructions appended to the ${role}'s assignment.`}
                onChange={(e) => onChangeOverride(role, e.target.value)}
              />
            </Field>
          ))}
        </Advanced>

        {/* The authorization summary is the contract of the Start button, so it
            is plain, always-visible text — readable at any width, never behind
            hover (docs/agent-workflows.md, "Concurrency and safety"). */}
        <Alert role="note">
          <ShieldCheck />
          <AlertTitle>What starting allows</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              <li>
                Coordinator plus implementer and reviewer sessions for this run
              </li>
              <li>
                One new worktree and branch for this Task, forked from{` `}
                {effectiveBaseBranch ? (
                  <span className="font-mono">{effectiveBaseBranch}</span>
                ) : (
                  "the main checkout branch"
                )}
              </li>
              <li>Commits inside that worktree</li>
              <li>Push and a pull request — only after review passes</li>
            </ul>
            <p className="mt-1.5">
              It does not merge, complete the Task, or remove the worktree or
              branches — those stay your decisions.
            </p>
          </AlertDescription>
        </Alert>

        {error ? <ErrorNote message={error} /> : null}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
        {pending ? (
          <>
            <span
              role="status"
              className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-muted-foreground"
            >
              <Spinner size="sm" />
              <span className="truncate">
                {phase && phase !== "failed" ? PHASE_LABEL[phase] : "Starting…"}
              </span>
              {branch ? (
                <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{branch}</span>
                </span>
              ) : null}
            </span>
            <Button variant="ghost" onClick={onContinueInBackground}>
              Run in background
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onStart} disabled={!ready}>
              Start run
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** A checkbox with its sentence-long label. */
function CheckboxField({
  id,
  checked,
  disabled,
  onChange,
  children,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Field orientation="horizontal">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
      <FieldLabel htmlFor={id} className="font-normal">
        {children}
      </FieldLabel>
    </Field>
  );
}

/** A collapsed advanced section. */
function Advanced({
  title,
  badge,
  children,
}: {
  title: string;
  badge?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger
        render={<Button variant="ghost" className="w-full justify-start" />}
      >
        <ChevronRight className="in-aria-expanded:rotate-90" />
        {title}
        {badge ? <Badge variant="secondary">{badge}</Badge> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t p-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One run limit as a bounded, touch-friendly discrete slider: the chosen number
 * stays visible beside the label, and the slider itself carries the spoken
 * value ("up to 4 sessions") rather than a bare index. Both say "up to",
 * because every one of these numbers is a ceiling — a bare "4" beside "Review
 * passes" reads like an instruction to run four of them.
 */
function LimitSlider({
  label,
  bounds,
  value,
  unit,
  hint,
  disabled,
  onChange,
}: {
  label: string;
  bounds: { min: number; max: number };
  value: number;
  /** Plural-aware noun for the number, used in the spoken value. */
  unit: string;
  hint: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-muted-foreground">{label}</span>
        <span className="font-medium">
          <span className="text-muted-foreground">{"up to "}</span>
          <span className="tabular-nums">{value}</span>
        </span>
      </div>
      <DiscreteSlider
        min={bounds.min}
        max={bounds.max}
        value={value}
        onChange={onChange}
        ariaLabel={label}
        valueText={`up to ${String(value)} ${unit}`}
        disabled={disabled}
      />
      <p className="text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * @component WorkflowRunStartSheet
 * @purpose The Run-workflow start flow for a Task: a compact summary of the
 * coordinator runtime and the four role-scoped candidate sets (each expandable
 * into the new-session runtime controls, addable and removable), the run limits
 * as bounded sliders,
 * per-run prompt overrides under Advanced, and the always-visible authorization
 * summary of exactly what starting a run permits. The last STARTED
 * configuration is restored for the next run; cancelling changes nothing.
 * Starting streams provisioning phases; while pending the surface is not
 * dismissible — the explicit "Run in background" hands the outcome to the
 * host's toast instead.
 * @useWhen The Task inspector's "Run workflow" action was chosen.
 * @related WorkflowRunStartLayer, ui/RuntimePicker, objectInspectors
 * (TaskInspector), useAssistant (startWorkflowRun), docs/agent-workflows.md.
 */
export function WorkflowRunStartSheet({
  task,
  tasks,
  models,
  worktrees,
  usageIndicators,
  storedRuntimes,
  storedLimits,
  startStates,
  onStart,
  onRemember,
  onContinueInBackground,
  onClearStart,
  onClose,
}: {
  task: { id: string; title: string; projectId?: string };
  /** Current Task list, used only to walk this Task's parent chain. */
  tasks: readonly WorkflowBaseTask[];
  /** Account-aware model options (the same list the Settings agents pick from). */
  models: AccountModelOption[];
  /** Includes the synthetic main checkout and active spawned worktrees. */
  worktrees: readonly WorkflowBaseWorktree[];
  /** Cached subscription usage for the account cards; display-only. */
  usageIndicators?: UsageIndicator[] | null;
  storedRuntimes: Prefs["workflowRoleRuntimes"];
  storedLimits: Prefs["workflowRunLimits"];
  /** Per-request `startWorkflowRun` progress; this flow reads only its own id. */
  startStates: Record<
    string,
    {
      requestId: string;
      phase: WorkflowRunStartPhase;
      branch?: string;
      error?: string;
    }
  >;
  onStart: (input: {
    taskId: string;
    config: CodeDeliveryWorkflowConfig;
    baseBranch?: string;
    limits?: WorkflowRunLimits;
    requestId: string;
  }) => void;
  /** Remember the configuration a run was actually STARTED with. */
  onRemember: (remembered: {
    runtimes: StoredRoleRuntimes;
    limits: WorkflowRunLimits;
  }) => void;
  /**
   * The user chose to close the surface while starting continues; the host
   * owns delivering that request's outcome (a toast) once it lands — and owns
   * clearing that entry, so this flow must NOT.
   */
  onContinueInBackground: (requestId: string) => void;
  /** Drop a request entry this flow consumed itself (started shown, or closed). */
  onClearStart: (requestId: string) => void;
  onClose: () => void;
}) {
  const mobile = useMobileLayout();
  const [roles, setRoles] = useState<WorkflowStartRoles>(() =>
    initialRoleStates(models, storedRuntimes),
  );
  // Stale stored limits are repaired rather than dropped: bounds can move.
  const [limits, setLimits] = useState<WorkflowRunLimits>(() =>
    normalizeWorkflowRunLimits(storedLimits),
  );
  const [customLimits, setCustomLimits] = useState(false);
  const baseBranches = useMemo(
    () => workflowBaseBranchOptions(task.projectId, worktrees),
    [task.projectId, worktrees],
  );
  const preferredBaseBranch = useMemo(
    () =>
      preferredWorkflowBaseBranch(task.id, task.projectId, tasks, worktrees),
    [task.id, task.projectId, tasks, worktrees],
  );
  // Parent-derived defaults are per-Task and never remembered. Undefined still
  // means the current main-checkout branch for a Task with no staged ancestor.
  const [baseBranch, setBaseBranch] = useState<string | undefined>(
    preferredBaseBranch,
  );
  const [baseBranchEdited, setBaseBranchEdited] = useState(false);
  useEffect(() => {
    if (!baseBranchEdited) setBaseBranch(preferredBaseBranch);
  }, [baseBranchEdited, preferredBaseBranch]);
  // Prompt overrides are per-RUN on purpose: Task-specific instructions must
  // not silently follow the user into the next, unrelated Task.
  const [overrides, setOverrides] = useState<WorkflowPromptOverrides>({
    implementer: "",
    reviewer: "",
  });
  const [ciSettings, setCiSettings] = useState<WorkflowCiSettings>({
    earlyPush: WORKFLOW_CI_DEFAULTS.enabled,
    timeoutSeconds: WORKFLOW_CI_DEFAULTS.timeoutMs / 1_000,
    pollIntervalSeconds: WORKFLOW_CI_DEFAULTS.pollIntervalMs / 1_000,
  });
  const [requestId, setRequestId] = useState<string | null>(null);

  // The models list can arrive after the sheet opened (profiles load async);
  // fill still-empty pickers once it does, without clobbering a user's pick.
  useEffect(() => {
    if (models.length === 0) return;
    setRoles((current) => {
      let changed = false;
      const initial = initialRoleStates(models, storedRuntimes);
      const fill = (
        state: WorkflowStartRoleState,
        filled: WorkflowStartRoleState | undefined,
      ) => {
        if (state.model || !filled) return state;
        changed = true;
        return filled;
      };
      const next: WorkflowStartRoles = {
        coordinator: fill(current.coordinator, initial.coordinator),
        sets: Object.fromEntries(
          CANDIDATE_ROLES.map((role) => [
            role,
            current.sets[role].map((candidate, index) =>
              fill(
                candidate,
                initial.sets[role][index] ?? initial.sets[role][0],
              ),
            ),
          ]),
        ) as WorkflowStartRoles["sets"],
      };
      return changed ? next : current;
    });
  }, [models, storedRuntimes]);

  const mine = requestId ? (startStates[requestId] ?? null) : null;
  const failed = mine?.phase === "failed" ? mine : null;
  const pending = Boolean(requestId) && !failed && mine?.phase !== "started";

  // A started run is the end of this surface: confirm, drop the consumed
  // entry, and get out of the way.
  useEffect(() => {
    if (!mine || mine.phase !== "started") return;
    const toast = workflowStartOutcomeToast(mine);
    if (toast) showToast(toast.message, { tone: toast.tone });
    onClearStart(mine.requestId);
    onClose();
  }, [mine, onClearStart, onClose]);

  // Ordinary dismissal (Cancel, X, backdrop, Escape — only offered while not
  // pending): a failed attempt's entry was consumed inline, so drop it. What
  // was edited here is deliberately NOT remembered — only starting is.
  const close = () => {
    if (requestId) onClearStart(requestId);
    onClose();
  };

  const start = () => {
    const coordinator = roles.coordinator.model;
    const candidateSets = Object.fromEntries(
      CANDIDATE_ROLES.map((role) => [
        role,
        roles.sets[role].flatMap((candidate) => {
          const config = workflowCandidateConfigOf(candidate);
          return config ? [config] : [];
        }),
      ]),
    ) as CodeDeliveryWorkflowConfig["roles"];
    if (!coordinator) return;
    if (
      CANDIDATE_ROLES.some((role) => {
        const bounds = WORKFLOW_ROLE_SET_BOUNDS[role];
        return (
          candidateSets[role].length !== roles.sets[role].length ||
          candidateSets[role].length < bounds.min ||
          candidateSets[role].length > bounds.max
        );
      })
    )
      return;
    // A retry after a failure replaces `requestId`, which would orphan the
    // previous attempt's terminal entry: nothing would ever address it again.
    // Its inline error was consumed (the user is retrying), so drop it now.
    // Start is only reachable while not pending, so a lingering id here is
    // always a terminal one.
    if (requestId) onClearStart(requestId);
    onRemember({ runtimes: rememberedRuntimes(roles), limits });
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `wf-${Date.now()}`;
    setRequestId(id);
    onStart({
      taskId: task.id,
      config: {
        coordinator: workflowRoleConfigOf(
          coordinator,
          roles.coordinator.thinkingLevel,
          "",
        ),
        roles: candidateSets,
        earlyPush: ciSettings.earlyPush,
        ciTimeoutMs:
          Math.max(30, Math.min(1_800, ciSettings.timeoutSeconds || 600)) *
          1_000,
        ciPollIntervalMs:
          Math.max(1, Math.min(60, ciSettings.pollIntervalSeconds || 5)) *
          1_000,
        ...(overrides.implementer.trim()
          ? { implementerPromptOverride: overrides.implementer.trim() }
          : {}),
        ...(overrides.reviewer.trim()
          ? { reviewerPromptOverride: overrides.reviewer.trim() }
          : {}),
      },
      ...(baseBranch !== undefined ? { baseBranch } : {}),
      ...(customLimits ? { limits } : {}),
      requestId: id,
    });
  };

  const continueInBackground = () => {
    if (requestId) onContinueInBackground(requestId);
    showToast("The workflow run keeps starting in the background.");
    onClose();
  };

  const layer: ReactNode = (
    <WorkflowRunStartLayer
      task={task}
      models={models}
      usageIndicators={usageIndicators}
      roles={roles}
      limits={limits}
      baseBranches={baseBranches}
      baseBranch={baseBranch}
      onChangeBaseBranch={(branch) => {
        setBaseBranchEdited(true);
        setBaseBranch(branch);
      }}
      customLimits={customLimits}
      overrides={overrides}
      ciSettings={ciSettings}
      pending={pending}
      phase={mine?.phase}
      branch={mine?.branch}
      error={failed?.error ?? (failed ? "Starting the run failed." : undefined)}
      onChangeRole={(row, patch) =>
        setRoles((current) =>
          row === "coordinator"
            ? { ...current, coordinator: { ...current.coordinator, ...patch } }
            : (() => {
                const [role, rawIndex] = row.split(":") as [
                  WorkflowCandidateRole,
                  string,
                ];
                const target = Number(rawIndex);
                return {
                  ...current,
                  sets: {
                    ...current.sets,
                    [role]: current.sets[role].map((candidate, index) =>
                      index === target ? { ...candidate, ...patch } : candidate,
                    ),
                  },
                };
              })(),
        )
      }
      onAddConfiguration={(role) =>
        setRoles((current) =>
          canAddConfiguration(role, current.sets[role].length)
            ? {
                ...current,
                sets: {
                  ...current.sets,
                  [role]: [
                    ...current.sets[role],
                    defaultRoleSelection(models, undefined),
                  ],
                },
              }
            : current,
        )
      }
      onRemoveConfiguration={(role, index) =>
        setRoles((current) =>
          canRemoveConfiguration(role, current.sets[role].length)
            ? {
                ...current,
                sets: {
                  ...current.sets,
                  [role]: current.sets[role].filter(
                    (_candidate, position) => position !== index,
                  ),
                },
              }
            : current,
        )
      }
      onChangeLimits={(patch) =>
        setLimits((current) => applyWorkflowRunLimits(current, patch))
      }
      onChangeCustomLimits={setCustomLimits}
      onChangeOverride={(role, text) =>
        setOverrides((current) => ({ ...current, [role]: text }))
      }
      onChangeCiSettings={(patch) =>
        setCiSettings((current) => ({ ...current, ...patch }))
      }
      onResetDefaults={() => {
        setRoles(initialRoleStates(models, undefined));
        setLimits(defaultWorkflowRunLimits());
        setCustomLimits(false);
        setBaseBranchEdited(false);
        setBaseBranch(preferredBaseBranch);
        setOverrides({ implementer: "", reviewer: "" });
        setCiSettings({
          earlyPush: WORKFLOW_CI_DEFAULTS.enabled,
          timeoutSeconds: WORKFLOW_CI_DEFAULTS.timeoutMs / 1_000,
          pollIntervalSeconds: WORKFLOW_CI_DEFAULTS.pollIntervalMs / 1_000,
        });
      }}
      onStart={start}
      onClose={close}
      onContinueInBackground={continueInBackground}
    />
  );
  // Every way out — Escape, the backdrop, the close button — follows the same
  // dismissal rule.
  const onOpenChange = (open: boolean) => {
    if (!open && canDismissWorkflowStart(pending)) close();
  };
  // A full-screen flow on a phone, per the screens model: one pane fills the
  // viewport, with the safe-area insets owned here since no shell chrome is
  // behind it.
  if (mobile)
    return (
      <Sheet open onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          aria-label="Run workflow"
          className="h-dvh gap-0"
          style={{
            paddingTop: "var(--app-safe-area-top, 0px)",
            paddingBottom: "var(--app-safe-area-bottom, 0px)",
          }}
        >
          {layer}
        </SheetContent>
      </Sheet>
    );
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        aria-label="Run workflow"
        className="flex max-h-11/12 flex-col gap-0 p-0 sm:max-w-xl"
      >
        {layer}
      </DialogContent>
    </Dialog>
  );
}
