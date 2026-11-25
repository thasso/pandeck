/**
 * Remembered model refusals (`docs/account-routing.md`, hard filter): which
 * concrete model ids a provider refused to run on an account
 * (`model_unavailable`). Keyed by (account, model provider, concrete id), in
 * memory only, rebuilt empty at boot. The models port reads it, so routing,
 * pins, admission and moves skip a marked account for that id; for Claude the
 * per-account resolution falls back to the alias's next candidate.
 *
 * It is not a bench: nothing expires on a timer and usage never clears it.
 * Only these clear a mark:
 * - a successful Claude listing naming the id, whose read started after the
 *   mark (`clearListedModels`);
 * - a successful own-subscription run on the exact (provider, id);
 * - the account's completed login (all its marks);
 * - the user's model Refresh (every mark);
 * - the account's deletion.
 * Background refreshes, create, rename, enable and disable never do.
 *
 * Light by contract: no engine imports (`architecture.test.ts`).
 */

interface Deps {
  now: () => number;
}

/** When each refused id of one (account, provider) was marked. */
type Marks = Map<string, number>;

let deps: Deps = { now: () => Date.now() };
const accounts = new Map<string, Map<string, Marks>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.warn(
        "[model-unavailability] change listener failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function marksOf(profileId: string, provider: string): Marks | undefined {
  return accounts.get(profileId)?.get(provider);
}

/** Drop empty containers so the store holds only real marks. */
function prune(profileId: string, provider: string): void {
  const byProvider = accounts.get(profileId);
  if (!byProvider) return;
  if (byProvider.get(provider)?.size === 0) byProvider.delete(provider);
  if (byProvider.size === 0) accounts.delete(profileId);
}

/** The store's clock, which a Claude listing stamps its read start with. */
export function modelUnavailabilityNow(): number {
  return deps.now();
}

/**
 * The provider refused to run `modelId` on the account. A repeated mark keeps
 * its first time and notifies nobody.
 */
export function markModelUnavailable(
  profileId: string,
  provider: string,
  modelId: string,
): void {
  if (!profileId || !provider || !modelId) return;
  if (marksOf(profileId, provider)?.has(modelId)) return;
  let byProvider = accounts.get(profileId);
  if (!byProvider) {
    byProvider = new Map();
    accounts.set(profileId, byProvider);
  }
  let marks = byProvider.get(provider);
  if (!marks) {
    marks = new Map();
    byProvider.set(provider, marks);
  }
  marks.set(modelId, deps.now());
  notify();
}

/** The account's refused ids for the provider; empty when none. */
export function unavailableModelIds(
  profileId: string,
  provider: string,
): ReadonlySet<string> {
  return new Set(marksOf(profileId, provider)?.keys() ?? []);
}

export function modelMarkedUnavailable(
  profileId: string,
  provider: string,
  modelId: string,
): boolean {
  return marksOf(profileId, provider)?.has(modelId) === true;
}

/**
 * A successful listing of the account names `listed`: each listed id marked
 * before the read started (`readStartedAt`, from
 * {@link modelUnavailabilityNow}) is no longer refused. A mark made while the
 * read ran stays, since the listing may predate it.
 */
export function clearListedModels(
  profileId: string,
  provider: string,
  listed: ReadonlySet<string>,
  readStartedAt: number,
): void {
  const marks = marksOf(profileId, provider);
  if (!marks) return;
  let changed = false;
  for (const [modelId, markedAt] of marks)
    if (listed.has(modelId) && markedAt < readStartedAt) {
      marks.delete(modelId);
      changed = true;
    }
  if (!changed) return;
  prune(profileId, provider);
  notify();
}

/** A successful run on exactly this (provider, id) on the account. */
export function clearModelUnavailable(
  profileId: string,
  provider: string,
  modelId: string,
): void {
  if (!marksOf(profileId, provider)?.delete(modelId)) return;
  prune(profileId, provider);
  notify();
}

/** The account's completed login or deletion: every mark it had goes. */
export function clearAccount(profileId: string): void {
  if (!accounts.delete(profileId)) return;
  notify();
}

/** The user's model Refresh: every mark goes. */
export function clearAll(): void {
  if (accounts.size === 0) return;
  accounts.clear();
  notify();
}

/** Hear when any account's marks actually changed. Returns the unsubscribe. */
export function subscribeModelUnavailabilityChanged(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Tests only: forget every mark and use these deps (the defaults when
 * omitted); subscribers stay.
 */
export function resetModelUnavailabilityForTests(
  next: Partial<Deps> = {},
): void {
  accounts.clear();
  deps = { now: () => Date.now(), ...next };
}
