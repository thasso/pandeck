import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CredentialProfileProvider,
  ModelOption,
  ThinkingLevel,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { UsageCycleMeters } from "./UsageCycleMeters.tsx";
import { THINKING_LABELS } from "./ModelThinkingSelect.tsx";

/**
 * The runtime quick-pick controls — "who runs this, on which model, thinking
 * how hard" — as one set of components, so every surface that asks that
 * question asks it the same way. They own the snap-scrolling, the selection
 * semantics (`listbox`/`option`), the scroll-into-view of the selected item and
 * the usage-meter slot; the callers own only what is offered and what happens
 * on a pick.
 *
 * Two surfaces use them today: the new-session landing
 * (`NewSessionQuickStart.tsx`) and the workflow start sheet
 * (`WorkflowRunStartSheet.tsx`).
 */

/** One provider account a runtime may run on, as the cards need it. */
export interface RuntimeAccount {
  /** Credential-profile id — the key usage indicators are keyed by too. */
  id: string;
  name: string;
  provider: CredentialProfileProvider;
}

const PROVIDER_LABEL: Record<CredentialProfileProvider, string> = {
  claude: "Claude",
  "openai-codex": "OpenAI",
};

/**
 * The provider-account row: one card per account, each carrying the brand icon,
 * the account NAME (several accounts share one provider, so the name is what
 * distinguishes them) and the fixed-height subscription-usage slot.
 *
 * Deliberately NO `aria-label` on a card: it would replace the computed name
 * and take the meter rows away from a screen reader (`docs/usage.md`).
 */
export function ProviderAccountRow({
  accounts,
  selectedId,
  usageIndicators,
  onSelect,
  label = "Provider",
  disabled = false,
}: {
  accounts: readonly RuntimeAccount[];
  selectedId: string | undefined;
  /**
   * Subscription-usage indicators from the server cache (`docs/usage.md`), or
   * null while the first snapshot has not arrived. Cards render the same slot
   * either way, so nothing reflows when it does.
   */
  usageIndicators: UsageIndicator[] | null | undefined;
  onSelect: (accountId: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const usageByProfileId = useMemo(
    () =>
      new Map((usageIndicators ?? []).map((item) => [item.profileId, item])),
    [usageIndicators],
  );
  // Usage rows age on their own clock: a snapshot goes stale (and a window
  // rolls over) with nothing arriving from the server to say so.
  const now = useCoarseNow();

  return (
    <QuickRow
      label={label}
      scrollKey={`${selectedId ?? ""}:${accounts.length}`}
    >
      {accounts.map((account) => {
        const selected = account.id === selectedId;
        const providerLabel = PROVIDER_LABEL[account.provider];
        return (
          <button
            key={account.id}
            type="button"
            role="option"
            aria-selected={selected}
            data-quick-selected={selected || undefined}
            disabled={disabled}
            title={`Use ${account.name} (${providerLabel})`}
            onClick={() => onSelect(account.id)}
            // Wider than the other cards, and a FIXED width rather than a
            // min/max range: the usage rows put a label, a meter, a number
            // and a countdown on one line, so a card sized to its account
            // name would leave neighbouring meters different lengths and
            // nothing on the strip would line up.
            className={`flex w-[13rem] shrink-0 snap-start flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${
              selected
                ? "border-accent/40 bg-accent-soft"
                : "border-line bg-panel hover:border-line-strong hover:bg-raised"
            }`}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <ProviderIcon
                provider={account.provider}
                title={providerLabel}
                size={16}
                className={
                  selected ? "shrink-0 text-accent" : "shrink-0 text-muted"
                }
              />
              <span
                className={`min-w-0 flex-1 truncate text-caption font-medium ${selected ? "text-accent" : "text-fg"}`}
              >
                {account.name}
              </span>
            </span>
            <UsageCycleMeters
              indicator={usageByProfileId.get(account.id)}
              now={now}
            />
          </button>
        );
      })}
    </QuickRow>
  );
}

/** The model row: one pill per offered model, provider icon included. */
export function ModelQuickRow<M extends ModelOption>({
  models,
  selected,
  onSelect,
  label = "Model",
  disabled = false,
}: {
  models: readonly M[];
  selected: M | undefined;
  onSelect: (model: M) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <QuickRow
      label={label}
      scrollKey={`${selected?.provider ?? ""}:${selected?.id ?? ""}:${models.length}`}
    >
      {models.map((model) => {
        const isSelected =
          model.provider === selected?.provider && model.id === selected?.id;
        return (
          <QuickPill
            key={`${model.provider}:${model.id}`}
            selected={isSelected}
            title={`Use ${model.name}`}
            disabled={disabled}
            onClick={() => onSelect(model)}
          >
            <ProviderIcon
              provider={model.provider}
              size={13}
              className={
                isSelected ? "shrink-0 text-accent" : "shrink-0 text-faint"
              }
            />
            <span className="min-w-0 truncate">{model.name}</span>
          </QuickPill>
        );
      })}
    </QuickRow>
  );
}

/**
 * Discrete horizontal slider over the model's supported thinking levels, with
 * the selected level's label centered below.
 */
export function ThinkingSlider({
  levels,
  value,
  onChange,
  disabled = false,
}: {
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
}) {
  const index = Math.max(0, levels.indexOf(value));

  return (
    <div className="mx-auto w-full max-w-sm px-4">
      <DiscreteSlider
        min={0}
        max={levels.length - 1}
        value={index}
        onChange={(next) => {
          const level = levels[next];
          if (level && level !== value) onChange(level);
        }}
        ariaLabel="Thinking level"
        valueText={THINKING_LABELS[value]}
        title={`Thinking: ${THINKING_LABELS[value]}`}
        disabled={disabled}
      />
      <div
        className="mt-0.5 text-center text-body font-medium text-fg"
        aria-hidden
      >
        {THINKING_LABELS[value]}
      </div>
    </div>
  );
}

/**
 * A bounded whole-number slider: a native range input (drag, tap and keyboard
 * for free) on top of a custom track with one visual stop per step. The
 * stops/fill sit inside a half-thumb inset so they line up with the thumb's
 * travel, which is bounded by the thumb width at both track ends.
 *
 * `valueText` is what a screen reader reads instead of the bare index — the
 * number alone is meaningless when the scale is positions in a list.
 */
export function DiscreteSlider({
  min,
  max,
  value,
  onChange,
  ariaLabel,
  valueText,
  title,
  disabled = false,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  valueText: string;
  title?: string;
  disabled?: boolean;
}) {
  const steps = Math.max(0, max - min) + 1;
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div className="relative h-10">
      {/* Track, fill, and stops are inset by half the 20px thumb so they align with its travel. */}
      <div className="absolute inset-x-2.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-line" />
      <div
        className="absolute left-2.5 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-accent"
        style={{ width: `calc((100% - 1.25rem) * ${percent / 100})` }}
      />
      <div className="absolute inset-x-1.5 top-1/2 flex -translate-y-1/2 justify-between">
        {Array.from({ length: steps }, (_, step) => (
          <span
            key={min + step}
            aria-hidden
            className={`size-2 rounded-full ${min + step <= value ? "bg-accent" : "bg-line-strong"}`}
          />
        ))}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next) && next !== value) onChange(next);
        }}
        aria-label={ariaLabel}
        aria-valuetext={valueText}
        title={title ?? `${ariaLabel}: ${valueText}`}
        className="absolute inset-0 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60 [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:bg-accent [&::-moz-range-track]:bg-transparent [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent"
      />
    </div>
  );
}

/** A once-a-minute clock — usage staleness and reset countdowns move by the minute. */
function useCoarseNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * One labelled horizontal snap-scroll row of pickable items. The row is the
 * `listbox`; its children are the `option`s, and the selected one carries
 * `data-quick-selected` so the row can scroll it into view.
 */
export function QuickRow({
  label,
  scrollKey,
  busy,
  children,
}: {
  label: string;
  /**
   * The row is showing placeholders instead of its items (R6): the listbox says
   * so rather than reading out an empty list of options.
   */
  busy?: boolean;
  /**
   * Bump/change to bring the row's `data-quick-selected` item into view —
   * covers the initial render (instant) and automatic selections such as the
   * project implied by a worktree pick (smooth). Include the item count so a
   * selection present before its async list loads still gets scrolled to.
   */
  scrollKey?: string;
  children: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstScroll = useRef(true);
  useEffect(() => {
    const selected = scrollRef.current?.querySelector(
      '[data-quick-selected="true"]',
    );
    if (selected) {
      selected.scrollIntoView({
        behavior: firstScroll.current ? "auto" : "smooth",
        inline: "center",
        block: "nearest",
      });
    }
    firstScroll.current = false;
  }, [scrollKey]);

  return (
    <div className="w-full">
      <div className="mb-1.5 px-4 text-center text-caption font-medium uppercase tracking-wide text-faint">
        {label}
      </div>
      {/* The gutter lives INSIDE the scroller (padding + matching scroll-padding
          for snapping), so cards keep the page inset at rest but scroll all the
          way to the viewport edge instead of being clipped by a dead margin. */}
      <div
        ref={scrollRef}
        className="flex snap-x snap-mandatory overflow-x-auto px-4 pb-1.5 scroll-px-4"
        role="listbox"
        aria-label={label}
        aria-busy={busy || undefined}
      >
        {/* Inner mx-auto wrapper centers a row that fits; an overflowing row
            fills the container and scrolls normally (cross-browser, unlike
            `justify-content: safe center`). */}
        <div className="mx-auto flex gap-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * Two small pickers sharing ONE row, each a labelled `listbox` of its own.
 *
 * For axes that are a couple of chips wide (agent, Build/Plan): a row apiece
 * costs vertical space the landing page does not have, and pushing one of them
 * off the surface entirely — into the composer's pill strip — is how a mode
 * nobody picked goes unnoticed.
 *
 * WRAPS rather than scrolling, unlike {@link QuickRow}: these groups are short
 * enough to fit a row on any desktop, and a phone that cannot fit them gets both
 * in full on two lines instead of a horizontal scroll whose second group starts
 * off-screen — the very invisibility this row exists to fix.
 */
export function QuickRowSplit({
  groups,
}: {
  groups: readonly { label: string; children: ReactNode }[];
}) {
  return (
    <div className="flex w-full flex-wrap justify-center gap-x-7 gap-y-3 px-4 pb-1.5">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col">
          <div className="mb-1.5 text-center text-caption font-medium uppercase tracking-wide text-faint">
            {group.label}
          </div>
          <div role="listbox" aria-label={group.label} className="flex gap-2">
            {group.children}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One pickable chip inside a {@link QuickRow}. */
export function QuickPill({
  selected,
  title,
  onClick,
  disabled = false,
  children,
}: {
  selected: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-quick-selected={selected || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-9 max-w-[13rem] shrink-0 snap-start items-center gap-1.5 rounded-xl border px-3 text-caption font-medium transition-colors disabled:opacity-60 ${
        selected
          ? "border-accent/40 bg-accent-soft text-accent"
          : "border-line bg-panel text-fg hover:border-line-strong hover:bg-raised"
      }`}
    >
      {children}
    </button>
  );
}
