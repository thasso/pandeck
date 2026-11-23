/**
 * One write call on the edge (Task-1463 P4b2, lifted for P5b): the guarded
 * prepare-then-apply runner both write tools share, so their order, timing
 * and classification cannot drift. A product supplies its texts, its config,
 * its two phases and its D-W2 mapper (`writeFailure.ts`); the descriptor
 * projects what the runner answers.
 *
 * In order: the credential, then the config; an aborted call stops; prepare
 * gets a budget that ends `PREPARE_RESERVE_MS` before the deadline, on a
 * signal joining the call's and the budget's, raced so a prepare that ignores
 * its signal is abandoned; the budget's timer is cleared however prepare
 * settles. A prepare rejection is classified by the call's signal, then the
 * budget's, and by nothing else. Before apply, the fence: the call's signal,
 * the budget's, then the absolute instant (a delayed timer callback cannot
 * let a late prepare through). Apply runs on the call's signal alone and
 * starts no item `STOP_CUTOFF_MS` before the deadline; its errors never
 * consult the budget.
 */
import {
  ToolError,
  abortError,
  raceAbort,
  type AtlassianCredential,
  type AtlassianToolDescriptor,
} from "./descriptor.ts";
import { projectText } from "./writeResult.ts";

/** The call's deadline: the measured 60 s client limit less 15 s. */
export const WRITE_DEADLINE_MS = 45_000;
/** The part of the deadline prepare never takes: apply's share. */
const PREPARE_RESERVE_MS = 22_000;
/** Apply starts no item this close to the deadline. */
export const STOP_CUTOFF_MS = 7_000;

export const STOP_TEXT =
  "Not applied: the call ran out of time before this change; nothing was sent for it.";
/** Above any prepare refusal (D-W2 caps its own texts at 1,000). */
export const PREPARE_REFUSAL_MAX = 1_200;
const ALL_FAILED_MAX = 2_000;

type WriteContext = Parameters<AtlassianToolDescriptor["execute"]>[1];

/** One call's two phases. Building them sends nothing. */
export interface WritePhases<Prepared, Applied> {
  /** Every read carries `signal`; an abort propagates as itself. */
  prepare(signal: AbortSignal): Promise<Prepared>;
  /** `stopBefore` is checked before each item (`STOP_TEXT` once past the cutoff). */
  apply(
    prepared: Prepared,
    signal: AbortSignal,
    stopBefore: () => string | undefined,
  ): Promise<Applied>;
}

/** What a product's write tool hands the runner, besides its phases. */
export interface WriteProduct<Config> {
  /** "Preparing the changes took too long; nothing was written to <product>. …" */
  prepareTooLong: string;
  /** Appended to a prepare refusal, with its leading space. */
  nothingWritten: string;
  /** A prepare refusal whose text cannot be shown. */
  prepareRefusalFallback: string;
  /** An all-failed apply whose text cannot be shown. */
  allFailedFallback: string;
  configOf(credential: AtlassianCredential): Config;
  /** D-W2: rethrows an abort (by name, or any of `signals` aborted). */
  describeError(
    err: unknown,
    credential: AtlassianCredential,
    signals: readonly AbortSignal[],
  ): string;
  /** The shared core's error when no item of apply succeeded. */
  isAllFailed(err: unknown): err is Error;
}

/**
 * Runs one write call; answers what prepare and apply produced, with the
 * credential the projection vets them against.
 */
export async function runWrite<Config, Prepared, Applied>(
  ctx: WriteContext,
  product: WriteProduct<Config>,
  phasesOf: (
    config: Config,
    credential: AtlassianCredential,
  ) => WritePhases<Prepared, Applied>,
): Promise<{
  credential: AtlassianCredential;
  prepared: Prepared;
  applied: Applied;
}> {
  // Nothing goes upstream before the credential is here.
  const credential = await ctx.credential();
  const config = product.configOf(credential);
  if (ctx.signal.aborted) throw abortError();
  const prepareEndsAt = ctx.deadlineAt - PREPARE_RESERVE_MS;
  const budgetMs = prepareEndsAt - Date.now();
  if (budgetMs <= 0) throw new ToolError(product.prepareTooLong);

  const phases = phasesOf(config, credential);
  const budget = new AbortController();
  const prepareSignal = AbortSignal.any([ctx.signal, budget.signal]);
  let prepared: Prepared;
  const timer = setTimeout(() => budget.abort(), budgetMs);
  try {
    prepared = await raceAbort(phases.prepare(prepareSignal), prepareSignal);
  } catch (err) {
    // By the prepare phase's own signals, the caller's first.
    if (ctx.signal.aborted) throw err;
    if (budget.signal.aborted) throw new ToolError(product.prepareTooLong);
    // The joined text is what leaves, so it is what is vetted (fix-2).
    throw new ToolError(
      projectText(
        product.describeError(err, credential, [prepareSignal]) +
          product.nothingWritten,
        credential,
        PREPARE_REFUSAL_MAX,
        product.prepareRefusalFallback,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  // The fence: a prepare that settled at or after its budget never writes,
  // even when the budget's timer callback has not run yet.
  if (ctx.signal.aborted) throw abortError();
  if (budget.signal.aborted || Date.now() >= prepareEndsAt)
    throw new ToolError(product.prepareTooLong);

  const stopAt = ctx.deadlineAt - STOP_CUTOFF_MS;
  let applied: Applied;
  try {
    applied = await phases.apply(prepared, ctx.signal, () =>
      Date.now() > stopAt ? STOP_TEXT : undefined,
    );
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    if (product.isAllFailed(err))
      throw new ToolError(
        projectText(
          err.message,
          credential,
          ALL_FAILED_MAX,
          product.allFailedFallback,
        ),
      );
    throw err;
  }
  return { credential, prepared, applied };
}
