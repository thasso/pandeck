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
import { Item } from "../ui/item.tsx";
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
          <Item
            key={account.id}
            render={<button type="button" disabled={disabled} />}
            variant={selected ? "muted" : "outline"}
            role="option"
            aria-selected={selected}
            data-quick-selected={selected || undefined}
            title={`Use ${account.name} (${providerLabel})`}
            onClick={() => onSelect(account.id)}
            className="w-52 shrink-0 snap-start flex-col items-start gap-1"
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
              <span
                className={`min-w-0 flex-1 truncate text-sm font-medium ${selected ? "text-primary" : "text-foreground"}`}
              >
                {account.name}
              </span>
            </span>
            <UsageCycleMeters
              indicator={usageByProfileId.get(account.id)}
              now={now}
            />
          </Item>
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
        className="mt-0.5 text-center text-sm font-medium text-foreground"
        aria-hidden
      >
        {THINKING_LABELS[value]}
      </div>
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
  return (
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
      className="flex h-10 items-center"
    />
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
      <div className="mb-1.5 px-4 text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
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
          <div className="mb-1.5 text-center text-sm font-medium uppercase tracking-wide text-muted-foreground">
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
    <Toggle
      pressed={selected}
      variant="outline"
      role="option"
      aria-selected={selected}
      data-quick-selected={selected || undefined}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="max-w-52 shrink-0 snap-start"
    >
      {children}
    </Toggle>
  );
}
