import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  CredentialProfileProvider,
  ModelOption,
  ThinkingLevel,
} from "@assistant/shared";
import type { UsageIndicator } from "@assistant/shared/usage";
import { Sparkles } from "lucide-react";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { UsageCycleMeters } from "./UsageCycleMeters.tsx";
import { THINKING_LABELS } from "./ModelThinkingSelect.tsx";
import { Slider } from "../ui/slider.tsx";
import { Toggle } from "../ui/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";

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
  automatic,
  label = "Provider",
  disabled = false,
}: {
  accounts: readonly RuntimeAccount[];
  selectedId: string | undefined;
  /**
   * Offer Automatic as the first card: no account is named, the server's
   * account router picks one when the run starts. The web workflow start sheet
   * deliberately omits it: people compare usage meters and pick each role's
   * account there. The server still routes unpinned roles from saved configs.
   */
  automatic?: {
    selected: boolean;
    onSelect: () => void;
    /** One muted line under the name, in the usage meters' slot. */
    detail: string;
  };
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
      scrollKey={`${automatic?.selected ? "automatic" : (selectedId ?? "")}:${accounts.length}`}
    >
      {automatic ? (
        <QuickPill
          selected={automatic.selected}
          disabled={disabled}
          title="Let Pandeck pick the account"
          onClick={automatic.onSelect}
          className={`w-52 ${QUICK_CARD}`}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <Sparkles
              size={16}
              aria-hidden
              className={
                automatic.selected
                  ? "shrink-0 text-primary"
                  : "shrink-0 text-muted-foreground"
              }
            />
            <span className="min-w-0 flex-1 truncate">Automatic</span>
          </span>
          <span className="w-full text-xs whitespace-normal text-muted-foreground">
            {automatic.detail}
          </span>
        </QuickPill>
      ) : null}
      {accounts.map((account) => {
        const selected = account.id === selectedId;
        const providerLabel = PROVIDER_LABEL[account.provider];
        return (
          <QuickPill
            key={account.id}
            selected={selected}
            disabled={disabled}
            title={`Use ${account.name} (${providerLabel})`}
            onClick={() => onSelect(account.id)}
            className={`w-52 ${QUICK_CARD}`}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <ProviderIcon
                provider={account.provider}
                title={providerLabel}
                size={16}
                className={
                  selected
                    ? "shrink-0 text-primary"
                    : "shrink-0 text-muted-foreground"
                }
              />
              <span className="min-w-0 flex-1 truncate">{account.name}</span>
            </span>
            <UsageCycleMeters
              indicator={usageByProfileId.get(account.id)}
              now={now}
            />
          </QuickPill>
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
      <ToggleGroup
        value={selected ? [`${selected.provider}:${selected.id}`] : []}
        onValueChange={(values) => {
          const next = models.find(
            (m) => `${m.provider}:${m.id}` === values[0],
          );
          if (next) onSelect(next);
        }}
        variant="outline"
        disabled={disabled}
      >
        {models.map((model) => {
          const isSelected =
            model.provider === selected?.provider && model.id === selected?.id;
          return (
            <ToggleGroupItem
              key={`${model.provider}:${model.id}`}
              value={`${model.provider}:${model.id}`}
              role="option"
              aria-selected={isSelected}
              data-quick-selected={isSelected || undefined}
              title={`Use ${model.name}`}
            >
              <ProviderIcon
                provider={model.provider}
                size={13}
                className={
                  isSelected
                    ? "shrink-0 text-primary"
                    : "shrink-0 text-muted-foreground"
                }
              />
              <span className="min-w-0 truncate">{model.name}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </QuickRow>
  );
}

/**
 * Discrete horizontal slider over the model's supported thinking levels, with
 * a tick per level and the selected level's label centered below (unless the
 * host states it in its own label).
 */
export function ThinkingSlider({
  levels,
  value,
  onChange,
  disabled = false,
  showValue = true,
}: {
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  disabled?: boolean;
  /** Off where the host states the level itself (the row's label). */
  showValue?: boolean;
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
      {showValue ? (
        <div
          className="mt-0.5 text-center text-sm font-medium text-foreground"
          aria-hidden
        >
          {THINKING_LABELS[value]}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A shadcn slider bounded to whole-number choices. The thumb announces the
 * choice's `valueText`, not the index that only the host understands.
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
  const steps = max - min;
  return (
    <div className="relative">
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value]}
        disabled={disabled}
        onValueChange={(values) => {
          const next = Array.isArray(values) ? values[0] : values;
          if (next !== undefined && next !== value) onChange(next);
        }}
        thumbProps={{ "aria-label": ariaLabel, "aria-valuetext": valueText }}
        title={title ?? `${ariaLabel}: ${valueText}`}
        // The control fills the whole 40px band, so a tap anywhere on it — not
        // only on the 4px track — picks the nearest choice; no drag needed.
        className="flex h-10 items-center *:h-full"
      />
      {/* A hollow stop on the track for every choice, drawn over it (after
          the slider) and click-through, so a tap still reaches the slider.
          The chosen one is under the thumb and left out. The slider keeps its
          12px thumb inside the track (`thumbAlignment="edge"`), so the stops
          run from 6px to 6px short of either end. */}
      {steps > 0 ? (
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {Array.from({ length: steps + 1 }, (_, index) =>
            min + index === value ? null : (
              <span
                key={index}
                className={`absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-background ${min + index < value ? "border-primary" : "border-muted-foreground/60"}`}
                style={{ left: `calc(6px + (100% - 12px) * ${index / steps})` }}
              />
            ),
          )}
        </div>
      ) : null}
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
      <div className="mb-1.5 px-4 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

/** A QuickPill laid out as a two-line card (worktrees, provider accounts). */
export const QUICK_CARD = "h-auto flex-col items-start gap-1 py-2 text-left";

export function QuickPill({
  selected,
  title,
  onClick,
  disabled = false,
  className = "",
  children,
}: {
  selected: boolean;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  /**
   * Layout only — a two-line card (`QUICK_CARD`) is still this Toggle, so its
   * border, hover and selected fill are the pills' own.
   */
  className?: string;
  children: ReactNode;
}) {
  return (
    <Toggle
      pressed={selected}
      variant="outline"
      role="option"
      aria-selected={selected}
      data-quick-selected={selected || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`max-w-52 shrink-0 snap-start ${className}`}
    >
      {children}
    </Toggle>
  );
}
