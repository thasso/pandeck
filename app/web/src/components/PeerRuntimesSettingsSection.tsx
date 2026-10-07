/**
 * Approved peer runtimes ([Task-595](pa://task/595)).
 *
 * The user's authority in one small list: each row is one exact account, model
 * and thinking level that an agent may start an ordinary peer session on
 * WITHOUT another approval card. Deliberately no roles, projects or budgets —
 * the coordinating agent describes the role in its own prompt, and everything
 * it may choose from is here.
 *
 * A row that cannot run right now is kept and explained rather than repaired or
 * hidden: the alternative is an agent silently landing on a runtime nobody
 * approved. Cost and the optional selection description are user-owned and are
 * exposed to coordinating agents; only model family is inferred.
 */
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isPeerRuntimeRelativeCost,
  isThinkingLevel,
  MAX_PEER_RUNTIME_DESCRIPTION_CHARS,
  MAX_PEER_SPAWN_RUNTIMES,
  MAX_SESSION_PEER_PROMPT_MAX_HOPS,
  MIN_SESSION_PEER_PROMPT_MAX_HOPS,
  PEER_RUNTIME_RELATIVE_COSTS,
  peerRuntimeFamilyOf,
  peerRuntimeUnavailableReason,
  type AccountModelOption,
  type AppSettings,
  type PeerRuntimeRelativeCost,
  type PeerSpawnRuntime,
} from "@assistant/shared";
import { AgentModelFields } from "./AgentModelFields.tsx";

/** Ids are generated here and never reused: an agent addresses a row by id. */
function newRuntimeId(): string {
  const random =
    globalThis.crypto?.randomUUID?.().slice(0, 8) ??
    Math.random().toString(36).slice(2, 10);
  return `pr_${random}`;
}

const COST_LABEL: Record<PeerRuntimeRelativeCost, string> = {
  low: "Lower cost",
  medium: "Mid cost",
  high: "Higher cost",
  unknown: "Cost unknown",
};

export function PeerRuntimesSettingsSection({
  models,
  settings,
  onUpdate,
}: {
  models: AccountModelOption[];
  settings: AppSettings;
  onUpdate: (patch: Partial<AppSettings>) => void;
}) {
  const rows = settings.peerSpawnRuntimes;
  // A new row is appended, so on a roster of any size it lands below the fold
  // while the button stays put: the click reads as doing nothing, and the user
  // clicks again. The row that has to show itself is named here and revealed
  // once, by the row itself, when it mounts.
  const [addedId, setAddedId] = useState<string | null>(null);
  const clearAdded = useCallback(() => setAddedId(null), []);
  // With no model to name, the row would be added with an empty `modelId` and
  // the server's normalizer drops it on the way in — the same click that
  // leaves nothing behind, one layer down. The button says why instead.
  const noModels = models.length === 0;

  const save = (next: PeerSpawnRuntime[]) =>
    onUpdate({ peerSpawnRuntimes: next });

  const addRuntime = () => {
    const first = models[0];
    const id = newRuntimeId();
    setAddedId(id);
    save([
      ...rows,
      {
        id,
        relativeCost: "unknown",
        credentialProfileId: first?.credentialProfileId ?? "",
        provider: first?.provider ?? "",
        modelId: first?.id ?? "",
        thinkingLevel: "medium",
        enabled: true,
      },
    ]);
  };

  const updateRuntime = (id: string, patch: Partial<PeerSpawnRuntime>) =>
    save(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const removeRuntime = (id: string) =>
    save(rows.filter((row) => row.id !== id));

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <h2 className="text-sm font-semibold">Peer sessions</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Control how agents coordinate with ordinary peer sessions and which
        runtimes they may start without asking you first.
      </p>

      <div className="mt-6 rounded-xl border border-line bg-panel p-4">
        <label className="block text-sm font-medium text-fg">
          Maximum uninterrupted peer-prompt hops
          <input
            type="number"
            min={MIN_SESSION_PEER_PROMPT_MAX_HOPS}
            max={MAX_SESSION_PEER_PROMPT_MAX_HOPS}
            step={1}
            value={settings.sessionPeerPromptMaxHops}
            onChange={(event) => {
              const value = event.target.valueAsNumber;
              if (!Number.isFinite(value)) return;
              onUpdate({ sessionPeerPromptMaxHops: value });
            }}
            className="settings-input mt-1.5 w-full"
          />
        </label>
        <p className="mt-2 text-sm text-faint">
          A causal agent-to-agent conversation is blocked after this many sends
          without you in the loop. Your next prompt closes the chain. Choose a
          value from {MIN_SESSION_PEER_PROMPT_MAX_HOPS} to{" "}
          {MAX_SESSION_PEER_PROMPT_MAX_HOPS}; changes apply to the next peer
          send, including an existing conversation.
        </p>
      </div>

      <p className="mt-6 text-sm text-muted-foreground">
        Approving a runtime permits paid sessions on exactly that account, model
        and thinking level. Anything else still comes to you as an approval
        card. Spawned sessions appear in your sidebar, where you can read,
        re-prompt or take over any of them.
      </p>

      <div className="mt-4 rounded-xl border border-line bg-panel p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Approved runtimes</div>
            <div className="mt-0.5 text-sm text-muted-foreground">
              Two thinking levels for one model are two rows. Cost and the
              description help agents choose; changes apply to the next session
              an agent starts and never change a running one.
            </div>
          </div>
          <button
            type="button"
            onClick={addRuntime}
            disabled={noModels || rows.length >= MAX_PEER_SPAWN_RUNTIMES}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-raised px-2.5 py-1 text-sm text-muted-foreground hover:bg-surface hover:text-fg disabled:opacity-50"
          >
            <Plus size={12} />
            Add runtime
          </button>
        </div>

        {noModels ? (
          <p className="mb-3 text-sm text-warning">
            No account offers a model right now, so there is nothing to approve.
            Enable an account under Models &amp; providers first.
          </p>
        ) : null}

        {rows.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface px-3 py-3 text-center text-sm text-faint">
            No approved runtimes. Agents must ask you to approve every batch.
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <RuntimeRow
                key={row.id}
                row={row}
                models={models}
                justAdded={row.id === addedId}
                onRevealed={clearAdded}
                onChange={updateRuntime}
                onRemove={removeRuntime}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RuntimeRow({
  row,
  models,
  justAdded,
  onRevealed,
  onChange,
  onRemove,
}: {
  row: PeerSpawnRuntime;
  models: AccountModelOption[];
  justAdded: boolean;
  onRevealed: () => void;
  onChange: (id: string, patch: Partial<PeerSpawnRuntime>) => void;
  onRemove: (id: string) => void;
}) {
  const family = peerRuntimeFamilyOf(row.provider, row.modelId);
  const unavailable = peerRuntimeUnavailableReason(row, models);
  const nameRef = useRef<HTMLInputElement>(null);
  const revealedRef = useRef(false);
  // Only the row the user just added moves the page, and only once: scrolling
  // on any other render would fight a user who has scrolled away. The ref, not
  // `onRevealed`, is what makes it once — StrictMode replays mount effects
  // before the queued state change lands, so the flag alone would scroll twice
  // in development. The name field is both the proof the row exists and the
  // first thing to fill in, so it takes focus — after the scroll, which
  // `preventScroll` keeps from being undone by the browser's own focus jump.
  useEffect(() => {
    if (!justAdded || revealedRef.current) return;
    revealedRef.current = true;
    const node = nameRef.current;
    node?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    node?.focus({ preventScroll: true });
    onRevealed();
  }, [justAdded, onRevealed]);
  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="text-sm font-medium text-muted-foreground">
            Name
          </span>
          <input
            ref={nameRef}
            type="text"
            value={row.name ?? ""}
            onChange={(event) => onChange(row.id, { name: event.target.value })}
            placeholder={`${row.modelId || "model"} · ${row.thinkingLevel} thinking`}
            className="settings-input w-full"
          />
        </label>
        <button
          type="button"
          onClick={() => onRemove(row.id)}
          aria-label={`Remove runtime ${row.name?.trim() || row.modelId}`}
          title="Remove runtime"
          className="mt-6 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mt-3">
        <AgentModelFields
          models={models}
          provider={row.provider}
          modelId={row.modelId}
          // A stored level this build cannot run is kept as-is by settings —
          // repairing it would authorize a runtime nobody picked. `exact` is
          // what makes the picker honest about it: a level outside the
          // vocabulary OR outside this model's ladder shows as no selection
          // rather than as its nearest neighbour, and changing the model alone
          // writes no level. The reason line below explains the state; picking
          // a level here is the repair.
          thinkingLevel={
            isThinkingLevel(row.thinkingLevel) ? row.thinkingLevel : undefined
          }
          thinkingPlaceholder="Pick a level"
          thinkingSelection="exact"
          credentialProfileId={row.credentialProfileId}
          modelLabel="Account and model"
          // No fallback here: an unusable account makes the row unavailable
          // rather than moving it to the automatic one, so the slot notice
          // promising that move would be a lie. The row's own reason line
          // below says what really happens.
          accountFallback={false}
          onChange={(next) =>
            onChange(row.id, {
              provider: next.provider,
              modelId: next.modelId,
              // Omitted when only the model changed on a row whose level this
              // build cannot run: what the row records stays recorded until the
              // human replaces it deliberately.
              ...(next.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: next.thinkingLevel }),
              credentialProfileId: next.credentialProfileId ?? "",
            })
          }
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-muted-foreground">
          Cost
          <select
            value={row.relativeCost}
            onChange={(event) => {
              const relativeCost = event.target.value;
              if (isPeerRuntimeRelativeCost(relativeCost))
                onChange(row.id, { relativeCost });
            }}
            className="settings-input mt-1 w-full"
          >
            {PEER_RUNTIME_RELATIVE_COSTS.map((cost) => (
              <option key={cost} value={cost}>
                {COST_LABEL[cost]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(event) =>
              onChange(row.id, { enabled: event.target.checked })
            }
          />
          Enabled
        </label>
      </div>

      <label className="mt-3 block text-sm font-medium text-muted-foreground">
        Description
        <input
          type="text"
          value={row.description ?? ""}
          onChange={(event) =>
            onChange(row.id, { description: event.target.value })
          }
          maxLength={MAX_PEER_RUNTIME_DESCRIPTION_CHARS}
          placeholder="For example: Fast fixer for focused TypeScript changes; use a different-family reviewer."
          className="settings-input mt-1 w-full"
        />
      </label>
      <p className="mt-1 text-sm text-faint">
        Shown to agents as your hint for when to select this runtime. Family:{" "}
        {family}.
      </p>

      {row.enabled && unavailable ? (
        <p className="mt-2 text-sm text-warning">
          Unavailable: {unavailable} Agents cannot use this row until you repair
          or remove it; it never moves to another runtime.
        </p>
      ) : null}
    </li>
  );
}
