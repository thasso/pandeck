/**
 * Per-account Claude model snapshots (`docs/agent-harnesses.md`, models port):
 * the model ids each Claude account's subscription lists, read through the
 * credential gateway on the account's server lease
 * (`claudeSdk/modelsViaGateway.ts`). In memory only, rebuilt at boot.
 *
 * An account with no successful read is UNKNOWN, and the models port then
 * offers the curated list as before; a failed read keeps the last success. So
 * a read can only ever narrow an account to what it really lists.
 *
 * Ordering: every read carries a generation. A credential change, the user's
 * Refresh or a deletion starts a new generation, and only a read of the
 * current generation publishes, so a read that started before a login never
 * overwrites the one after it and a deleted account never reappears.
 */
import { CLAUDE_SDK_MODELS } from "../claudeSdk/modelSettings.ts";
import { fetchClaudeModelIdsViaGateway } from "../claudeSdk/modelsViaGateway.ts";
import {
  credentialProfileById,
  listCredentialProfiles,
  subscribeCredentialProfileChanges,
  subscribeCredentialProfileDeleted,
} from "../credentialProfiles.ts";
import { errorText } from "../errors.ts";
import { serverGatewayAccess } from "../gatewayLink.ts";

/** One account's listing, or undefined when this server cannot read one. */
type ClaudeModelsReader = (profileId: string) => Promise<string[] | undefined>;

export interface ClaudeAccountModelsDeps {
  read: ClaudeModelsReader;
  /** Whether the account is one to read: an existing, enabled Claude login. */
  readable: (profileId: string) => boolean;
  now: () => number;
  /** How long a routing wait lasts at most, lease and fetch together. */
  ensureBoundMs: number;
  /** After a failed read, how long before an unforced caller reads again. */
  retryFloorMs: number;
}

interface Read {
  generation: number;
  done: Promise<void>;
}

interface Entry {
  /** The last successful listing; undefined while unknown. */
  ids?: ReadonlySet<string>;
  /** The newest generation; only a read of it publishes. */
  generation: number;
  inFlight?: Read | undefined;
  /** When the last read of the current generation failed. */
  failedAt?: number | undefined;
  /** When a wait for the running read reached its bound. */
  stalledAt?: number | undefined;
}

export interface ClaudeAccountModelCache {
  /** The account's last listed ids; undefined while unknown. */
  ids(profileId: string): ReadonlySet<string> | undefined;
  /**
   * Resolve once the account is known, or at the bound: starts or joins a
   * read while nothing has succeeded yet (never sooner than the retry floor
   * after a failure). Never rejects.
   */
  ensure(profileId: string): Promise<void>;
  /**
   * Read the given accounts (default: every readable one). `force` starts a
   * new generation, never joining an older read; otherwise a running read of
   * the current generation is joined. Resolves when the reads settle.
   */
  refresh(options: { profileIds?: string[]; force: boolean }): Promise<void>;
  /** The account's credential changed: a new generation, read now. */
  credentialChanged(profileId: string): void;
  /** The account was deleted: its snapshot goes and no older read returns it. */
  forget(profileId: string): void;
  /** Hear which account's listed set actually changed. */
  subscribe(listener: (profileId: string) => void): () => void;
}

/** The curated concrete ids a plausible listing names at least one of. */
const CURATED_SDK_IDS = new Set(CLAUDE_SDK_MODELS.map((m) => m.sdkModelId));

function sameIds(
  a: ReadonlySet<string> | undefined,
  b: ReadonlySet<string>,
): boolean {
  return (
    a !== undefined && a.size === b.size && [...a].every((id) => b.has(id))
  );
}

export function createClaudeAccountModelCache(
  deps: ClaudeAccountModelsDeps,
): ClaudeAccountModelCache {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(profileId: string) => void>();
  // One counter for every account, so a generation never repeats, even for
  // an id that was deleted and created again.
  let nextGeneration = 1;

  const entryOf = (profileId: string): Entry => {
    let entry = entries.get(profileId);
    if (!entry) {
      entry = { generation: nextGeneration++ };
      entries.set(profileId, entry);
    }
    return entry;
  };

  const publish = (profileId: string): void => {
    for (const listener of listeners) {
      try {
        listener(profileId);
      } catch (err) {
        console.warn("[claude-models] change listener:", errorText(err));
      }
    }
  };

  const startRead = (profileId: string, entry: Entry): Read => {
    const generation = entry.generation;
    const current = (): boolean =>
      entries.get(profileId) === entry && entry.generation === generation;
    const read: Read = {
      generation,
      done: (async () => {
        let ids: string[] | undefined;
        try {
          ids = await deps.read(profileId);
        } catch (err) {
          if (!current()) return;
          entry.failedAt = deps.now();
          // The reader's texts are fixed: no token, no upstream prose.
          console.warn(
            `[claude-models] listing for ${profileId} failed; keeping the last one:`,
            errorText(err),
          );
          return;
        }
        // No gateway: nothing was read, and no attempt counts.
        if (ids === undefined || !current()) return;
        const listed = new Set(ids);
        if (![...CURATED_SDK_IDS].some((id) => listed.has(id))) {
          entry.failedAt = deps.now();
          console.warn(
            `[claude-models] listing for ${profileId} names no curated model; keeping the last one.`,
          );
          return;
        }
        entry.failedAt = undefined;
        if (sameIds(entry.ids, listed)) return;
        entry.ids = listed;
        publish(profileId);
      })().finally(() => {
        if (entry.inFlight !== read) return;
        entry.inFlight = undefined;
        entry.stalledAt = undefined;
      }),
    };
    entry.inFlight = read;
    return read;
  };

  /** The current generation's read, joined or started. */
  const currentRead = (profileId: string, entry: Entry): Read =>
    entry.inFlight?.generation === entry.generation
      ? entry.inFlight
      : startRead(profileId, entry);

  const forced = (profileId: string): Promise<void> => {
    if (!deps.readable(profileId)) return Promise.resolve();
    const entry = entryOf(profileId);
    entry.generation = nextGeneration++;
    entry.failedAt = undefined;
    entry.stalledAt = undefined;
    return startRead(profileId, entry).done;
  };

  return {
    ids: (profileId) => entries.get(profileId)?.ids,

    async ensure(profileId) {
      const known = entries.get(profileId);
      if (known?.ids) return;
      if (!deps.readable(profileId)) return;
      const entry = entryOf(profileId);
      const now = deps.now();
      const recent = (at: number | undefined): boolean =>
        at !== undefined && now - at < deps.retryFloorMs;
      const running = entry.inFlight?.generation === entry.generation;
      // Neither a recent failure nor a read that already outlived one wait
      // makes the next caller wait again: routing never pays per pick.
      if (running ? recent(entry.stalledAt) : recent(entry.failedAt)) return;
      const read = currentRead(profileId, entry);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        read.done.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), deps.ensureBoundMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      if (!settled && entry.inFlight === read) entry.stalledAt = deps.now();
    },

    async refresh({ profileIds, force }) {
      const ids =
        profileIds ??
        listCredentialProfiles()
          .map((profile) => profile.id)
          .filter((id) => deps.readable(id));
      await Promise.all(
        ids.map((profileId) => {
          if (force) return forced(profileId);
          if (!deps.readable(profileId)) return Promise.resolve();
          const entry = entryOf(profileId);
          return currentRead(profileId, entry).done;
        }),
      );
    },

    credentialChanged(profileId) {
      void forced(profileId);
    },

    forget(profileId) {
      const entry = entries.get(profileId);
      if (!entry) return;
      entries.delete(profileId);
      // A late completion sees a different (absent) entry and never publishes.
      entry.generation = nextGeneration++;
      if (entry.ids) publish(profileId);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const MODELS_FETCH_TIMEOUT_MS = 8_000;

async function readViaGateway(
  profileId: string,
): Promise<string[] | undefined> {
  // With the gateway off nothing reads: the server never holds a Claude token.
  const access = await serverGatewayAccess(profileId);
  if (!access) return undefined;
  return fetchClaudeModelIdsViaGateway(access, MODELS_FETCH_TIMEOUT_MS);
}

function readableClaudeProfile(profileId: string): boolean {
  const profile = credentialProfileById(profileId);
  return profile?.provider === "claude" && profile.enabled;
}

const DEFAULT_DEPS: ClaudeAccountModelsDeps = {
  read: readViaGateway,
  readable: readableClaudeProfile,
  now: () => Date.now(),
  ensureBoundMs: 10_000,
  retryFloorMs: 60_000,
};

const moduleListeners = new Set<(profileId: string) => void>();
function relay(profileId: string): void {
  for (const listener of moduleListeners) listener(profileId);
}
let cache = createClaudeAccountModelCache(DEFAULT_DEPS);
cache.subscribe(relay);

/**
 * Tests only: a fresh process-wide cache with these deps (the defaults when
 * omitted); subscribers of {@link subscribeClaudeAccountModelsChanged} stay.
 */
export function resetClaudeAccountModelsForTests(
  deps: Partial<ClaudeAccountModelsDeps> = {},
): ClaudeAccountModelCache {
  cache = createClaudeAccountModelCache({ ...DEFAULT_DEPS, ...deps });
  cache.subscribe(relay);
  return cache;
}

/** The Claude account's listed model ids; undefined while unknown. */
export function claudeAccountModelIds(
  profileId: string,
): ReadonlySet<string> | undefined {
  return cache.ids(profileId);
}

/** Wait (bounded) for a first listing of the account; never rejects. */
export function ensureClaudeAccountModels(profileId: string): Promise<void> {
  return cache.ensure(profileId);
}

/** Re-read every enabled Claude account's listing, as a new generation. */
export function refreshClaudeAccountModels(): Promise<void> {
  return cache.refresh({ force: true });
}

/** Hear which Claude account's listing changed. Returns the unsubscribe. */
export function subscribeClaudeAccountModelsChanged(
  listener: (profileId: string) => void,
): () => void {
  moduleListeners.add(listener);
  return () => moduleListeners.delete(listener);
}

const CLAUDE_MODELS_REFRESH_INTERVAL_MS = 60 * 60_000;

/**
 * Read every enabled Claude account now and then hourly, re-read one at once
 * when its credential changes (login, relogin, enable), and drop a deleted
 * one's snapshot. Unref'd: it never keeps the process alive. Returns the stop,
 * which ends the timer and both subscriptions.
 */
export function startClaudeAccountModelRefresh(): () => void {
  void cache.refresh({ force: false });
  const timer = setInterval(() => {
    void cache.refresh({ force: false });
  }, CLAUDE_MODELS_REFRESH_INTERVAL_MS);
  timer.unref?.();
  const unsubscribeChanges = subscribeCredentialProfileChanges((id) => {
    if (readableClaudeProfile(id)) cache.credentialChanged(id);
  });
  const unsubscribeDeleted = subscribeCredentialProfileDeleted((id) =>
    cache.forget(id),
  );
  return () => {
    clearInterval(timer);
    unsubscribeChanges();
    unsubscribeDeleted();
  };
}
