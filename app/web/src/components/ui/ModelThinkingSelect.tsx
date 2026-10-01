import type { ReactNode } from "react";
import { Brain, Check, ChevronDown, Gauge } from "lucide-react";
import {
  type AccountModelOption,
  type ModelOption,
  type ThinkingLevel,
  clampThinkingLevelForModel,
  providerLabel,
  supportedThinkingLevelsForModel,
} from "@assistant/shared";
import { Popover } from "../Popover.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";

/** Human label for each thinking level. */
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/** Compact label for tight spaces (e.g. the composer trigger on mobile). */
const THINKING_SHORT_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHi",
  max: "Max",
};

/** One-line hint about what each level does. */
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "Respond without extended thinking",
  minimal: "A touch of reasoning before answering",
  low: "A little reasoning before answering",
  medium: "Balanced reasoning for most tasks",
  high: "Deep, thorough reasoning",
  xhigh: "Very deep reasoning",
  max: "Maximum reasoning depth",
};

function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

function cx(...classes: Array<string | false | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** One popover group: provider by default, provider ACCOUNT when the options carry one. */
interface ModelGroup<M extends ModelOption> {
  key: string;
  label: string;
  /** Provider whose brand icon heads the group. */
  provider: string;
  models: M[];
}

function groupModels<M extends ModelOption>(models: M[]): ModelGroup<M>[] {
  const groups = new Map<string, ModelGroup<M>>();
  for (const m of models) {
    const account = accountOf(m);
    const key = account
      ? `account:${account.credentialProfileId}`
      : `provider:${m.provider}`;
    const label = account
      ? `${account.accountName}${account.accountDisabled ? " · disabled" : ""}`
      : providerLabel(m.provider, m.providerName);
    const group = groups.get(key) ?? {
      key,
      label,
      provider: m.provider,
      models: [],
    };
    group.models.push(m);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function accountOf(model: ModelOption): AccountModelOption | undefined {
  return "credentialProfileId" in model
    ? (model as AccountModelOption)
    : undefined;
}

type ModelRef =
  | { provider: string; id: string; credentialProfileId?: string }
  | ModelOption
  | undefined;

/**
 * Account-aware identity: the same model offered by two accounts is two
 * distinct choices, so the account participates whenever BOTH sides name one.
 */
function sameModel(
  a: ModelRef,
  b: { provider: string; id: string; credentialProfileId?: string },
): boolean {
  if (a?.provider !== b.provider || a?.id !== b.id) return false;
  const selected =
    a && "credentialProfileId" in a ? a.credentialProfileId : undefined;
  return (
    !selected || !b.credentialProfileId || selected === b.credentialProfileId
  );
}

/** Trigger presentation: a compact composer/toolbar pill, or a settings field. */
type SelectVariant = "pill" | "field";

// Shared trigger classes. `pill` is a dense ghost control for the composer;
// `field` looks like a form input for the settings page.
const PILL_TRIGGER =
  "inline-flex items-center gap-1.5 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-caption text-fg transition-colors hover:bg-raised data-[open=true]:bg-raised disabled:cursor-not-allowed disabled:opacity-50";
const FIELD_TRIGGER =
  "flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-body text-fg transition-colors hover:border-line-strong data-[open=true]:border-accent disabled:cursor-not-allowed disabled:opacity-60";

export interface ModelSelectProps<M extends ModelOption = ModelOption> {
  models: M[];
  /** Currently selected model (or a bare {provider,id[,credentialProfileId]}). */
  value: ModelRef;
  /** Called with the chosen model. */
  onChange: (model: M) => void;
  /** Optionally disable individual models (e.g. locked after a session started). */
  isModelDisabled?: ((model: M) => boolean) | undefined;
  /** Lock the whole control. */
  locked?: boolean;
  /** Trigger presentation. Defaults to `"pill"`. */
  variant?: SelectVariant;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Popover placement. Defaults to `"auto"`. */
  placement?: "top" | "bottom" | "auto";
  /** Trigger button classes. When set, fully replaces the variant default. */
  className?: string;
  /** Override the trigger title/tooltip. */
  title?: string;
}

/**
 * A model picker grouped by provider — or by provider ACCOUNT when the options
 * are {@link AccountModelOption}s, so picking a model also picks the account it
 * runs on. Built on the app's portal {@link Popover}; used consistently in the
 * composer (plain models) and the settings page (account/model combinations).
 */
export function ModelSelect<M extends ModelOption>({
  models,
  value,
  onChange,
  isModelDisabled,
  locked = false,
  variant = "pill",
  placeholder = "Select model",
  placement = "auto",
  className,
  title,
}: ModelSelectProps<M>) {
  const grouped = groupModels(models);
  // Prefer a full ModelOption when the caller passed one (so a locked session's
  // model still shows its name even if it's not in the filtered list); otherwise
  // resolve the {provider,id} ref against the available models.
  const selected =
    value && "name" in value
      ? (value as M)
      : value
        ? models.find((m) => sameModel(value, m))
        : undefined;
  const selectedAccount = selected ? accountOf(selected) : undefined;
  const triggerClass =
    className ?? (variant === "pill" ? PILL_TRIGGER : FIELD_TRIGGER);

  return (
    <Popover
      title={
        title ??
        (locked ? "Model is locked after this session started" : "Model")
      }
      placement={placement}
      className={triggerClass}
      disabled={locked}
      button={
        <>
          {selected ? (
            <ProviderIcon
              provider={selected.provider}
              size={15}
              className="shrink-0 text-faint"
            />
          ) : null}
          <span
            className={cx(
              "min-w-0 flex-1 truncate",
              variant === "pill" && "max-w-[170px] sm:max-w-[220px]",
            )}
          >
            {selected?.name ?? placeholder}
            {selectedAccount ? (
              <span className="text-faint">
                {" "}
                · {selectedAccount.accountName}
              </span>
            ) : null}
          </span>
          <ChevronDown size={13} className="shrink-0 text-faint" />
        </>
      }
    >
      {(close) => (
        <div className="max-h-[45vh] min-w-[240px] overflow-y-auto">
          {models.length === 0 && (
            <div className="px-3 py-2 text-caption text-faint">
              No models available
            </div>
          )}
          {grouped.map((group) => (
            <div
              key={group.key}
              className="py-1"
              role="group"
              aria-label={group.label}
            >
              <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-micro font-semibold uppercase tracking-wide text-faint">
                <ProviderIcon provider={group.provider} size={12} />
                {group.label}
              </div>
              {group.models.map((m) => {
                const active = sameModel(value, m);
                const disabled = Boolean(isModelDisabled?.(m));
                return (
                  <button
                    key={`${accountOf(m)?.credentialProfileId ?? ""}/${m.provider}/${m.id}`}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      if (disabled) return;
                      onChange(m);
                      close();
                    }}
                    disabled={disabled}
                    title={
                      disabled
                        ? "This model cannot be selected after this session has started."
                        : undefined
                    }
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-raised disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cx(
                          "block truncate text-caption font-medium",
                          active ? "text-accent" : "text-fg",
                        )}
                      >
                        {m.name}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-caption text-muted">
                        <span>
                          {formatContextTokens(m.contextWindow)} context
                        </span>
                        {m.reasoning && (
                          <span className="inline-flex items-center gap-1">
                            <Gauge size={11} /> reasoning
                          </span>
                        )}
                      </span>
                    </span>
                    {active && (
                      <Check size={14} className="shrink-0 text-accent" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

export interface ThinkingSelectProps {
  /** The model that constrains which levels are available. */
  model: ModelOption | undefined;
  /**
   * Currently selected level, or `undefined` for NO selection.
   *
   * Unset is a real state, not a missing prop: a stored value this build cannot
   * run must read as "nothing is selected here" rather than borrow the nearest
   * level, which would show the user an approval they never made.
   */
  value: ThinkingLevel | undefined;
  /** Called with the chosen level. */
  onChange: (level: ThinkingLevel) => void;
  /** Lock the whole control. */
  locked?: boolean;
  /** Trigger presentation. Defaults to `"pill"`. */
  variant?: SelectVariant;
  /** Popover placement. Defaults to `"auto"`. */
  placement?: "top" | "bottom" | "auto";
  /** Trigger button classes. When set, fully replaces the variant default. */
  className?: string;
  /** Override the trigger title/tooltip. */
  title?: string;
  /** Trigger label while nothing is selected. */
  placeholder?: string;
}

/**
 * A thinking-level picker constrained to the levels the current model accepts,
 * with one-line descriptions. Built on the app's portal {@link Popover}.
 */
export function ThinkingSelect({
  model,
  value,
  onChange,
  locked = false,
  variant = "pill",
  placement = "auto",
  className,
  title,
  placeholder = "Not set",
}: ThinkingSelectProps) {
  const reasoning = model?.reasoning ?? false;
  const levels = supportedThinkingLevelsForModel(model);
  // `undefined` stays undefined: clamping it would DISPLAY a level as chosen.
  const displayLevel =
    value === undefined
      ? undefined
      : levels.includes(value)
        ? value
        : clampThinkingLevelForModel(model, value);
  const triggerClass =
    className ?? (variant === "pill" ? PILL_TRIGGER : FIELD_TRIGGER);

  return (
    <Popover
      title={
        title ??
        (locked
          ? "Thinking level is locked after this session started"
          : "Thinking level")
      }
      placement={placement}
      className={triggerClass}
      disabled={locked}
      button={
        <>
          <Brain size={15} className="shrink-0 text-faint" />
          <span className={cx("min-w-0", variant === "field" && "flex-1")}>
            {/* Compact on small screens, full label otherwise. */}
            <span className="sm:hidden">
              {displayLevel ? THINKING_SHORT_LABELS[displayLevel] : placeholder}
            </span>
            <span className="hidden truncate sm:inline">
              {displayLevel ? THINKING_LABELS[displayLevel] : placeholder}
            </span>
          </span>
          <ChevronDown size={13} className="shrink-0 text-faint" />
        </>
      }
    >
      {(close) => (
        <div className="min-w-[220px] py-0.5">
          {!reasoning && (
            <div className="px-2.5 py-1 text-caption text-faint">
              Current model has no reasoning budget
            </div>
          )}
          {levels.map((lvl) => {
            const active = displayLevel === lvl;
            return (
              <button
                key={lvl}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  onChange(lvl);
                  close();
                }}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-raised"
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={cx(
                      "block text-caption font-medium",
                      active ? "text-accent" : "text-fg",
                    )}
                  >
                    {THINKING_LABELS[lvl]}
                  </span>
                  <span className="mt-0.5 block text-caption text-muted">
                    {THINKING_DESCRIPTIONS[lvl]}
                  </span>
                </span>
                {active && <Check size={14} className="shrink-0 text-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

/** A label wrapper so callers can pair a caption with a select trigger. */
export function SelectField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-caption font-medium text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
