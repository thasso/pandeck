/**
 * The "Background processes" settings card ([Task-467](pa://task/467)).
 *
 * Every value here is read ONCE, at admission, and frozen onto the admitted row.
 * The card therefore governs LATER admissions only, and the copy says so at each
 * control rather than in one disclaimer nobody reads: turning this off, or
 * lowering the cap, never kills, evicts, re-deadlines or re-shapes work that is
 * already running.
 */
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  normalizeBackgroundWorkSettings,
  type AppSettings,
  type BackgroundWorkSettings,
} from "@assistant/shared";

const RANGES = BACKGROUND_WORK_SETTINGS_RANGES;

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  fallback,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  fallback: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="mt-4 rounded-xl border border-line bg-panel p-4">
      <label className="block text-sm font-medium text-fg">
        {label}
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            // An emptied field is not a value: fall back to the shipped default
            // rather than writing NaN, which the shared normalizer would only
            // clamp back to the same place one round-trip later.
            if (!Number.isFinite(next)) {
              onChange(fallback);
              return;
            }
            onChange(Math.min(max, Math.max(min, Math.round(next))));
          }}
          className="settings-input mt-1.5 w-full"
        />
      </label>
      <p className="mt-2 text-sm text-faint">
        {hint} Choose a value from {min} to {max}; the default is {fallback}.
      </p>
    </div>
  );
}

export function BackgroundProcessesSettingsSection({
  settings,
  onUpdate,
}: {
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const card = normalizeBackgroundWorkSettings(settings.backgroundWork);
  const save = (patch: Partial<BackgroundWorkSettings>) =>
    onUpdate({ backgroundWork: { ...card, ...patch } });

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Background processes</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Shell commands and monitors an agent session starts and leaves running
        after its turn ends. They are governed by PA, not by your provider
        account, and are always visible and stoppable in the background
        registry.
      </p>

      <div className="mt-6 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={card.enabled}
            onChange={(event) => save({ enabled: event.target.checked })}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg">
              Allow sessions to start background work
            </span>
            <span className="mt-1 block text-sm text-faint">
              Turning this off denies every NEW background process. Work that is
              already running keeps running to its own deadline, stays listed,
              and can still be stopped — disabling is not a kill switch.
            </span>
          </span>
        </label>
      </div>

      <NumberField
        label="Sessions that may own background work at once"
        hint={
          "One slot covers everything a single session starts, so this caps OWNERS, " +
          "not processes. Lowering it never evicts an owner that already holds a slot; " +
          "it applies the next time a new session asks."
        }
        value={card.ownerSessionCap}
        min={RANGES.ownerSessionCap.min}
        max={RANGES.ownerSessionCap.max}
        fallback={DEFAULT_BACKGROUND_WORK_SETTINGS.ownerSessionCap}
        onChange={(ownerSessionCap) => save({ ownerSessionCap })}
      />

      <NumberField
        label="Process lifetime (minutes)"
        hint={
          "Frozen onto each process when it starts, and never re-read: changing it " +
          "moves no existing deadline. A process that reaches its deadline is stopped."
        }
        value={card.taskLifetimeMinutes}
        min={RANGES.taskLifetimeMinutes.min}
        max={RANGES.taskLifetimeMinutes.max}
        fallback={DEFAULT_BACKGROUND_WORK_SETTINGS.taskLifetimeMinutes}
        onChange={(taskLifetimeMinutes) => save({ taskLifetimeMinutes })}
      />

      <NumberField
        label="Claude empty-host grace (seconds)"
        hint={
          "How long a Claude session's retained background host stays open after its " +
          "last process ends, so the next one does not pay to start it again. Frozen " +
          "with the host: an edit governs the next host, not the one that is open."
        }
        value={card.claudeEmptyHostGraceSeconds}
        min={RANGES.claudeEmptyHostGraceSeconds.min}
        max={RANGES.claudeEmptyHostGraceSeconds.max}
        fallback={DEFAULT_BACKGROUND_WORK_SETTINGS.claudeEmptyHostGraceSeconds}
        onChange={(claudeEmptyHostGraceSeconds) =>
          save({ claudeEmptyHostGraceSeconds })
        }
      />

      <div className="mt-6 rounded-xl border border-line bg-panel p-4 text-sm text-muted-foreground">
        <p className="font-medium text-fg">What these settings do not change</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-4">
          <li>
            PA enforces the owner cap BEFORE Claude runs a background tool. It
            is a PA limit, not a setting on your Claude account, and Claude has
            no equivalent control to keep in sync.
          </li>
          <li>
            A persistent monitor survives the turn that started it and keeps
            reporting while its session is idle — but it is still governed by
            the lifetime above, and it is not exempt from Stop.
          </li>
          <li>
            Nothing resumes after a server restart. Work that was running is
            recorded as lost, and no process, monitor or retained host is
            brought back.
          </li>
          <li>
            Every value is read once, when a process is admitted. Editing this
            card governs later admissions only.
          </li>
        </ul>
      </div>
    </div>
  );
}
