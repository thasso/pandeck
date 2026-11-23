/**
 * A write tool's two phases on a client connection (Task-1463 P6a): gateway
 * client 1.1's `tools.prepare` answers the proposal the shared prepare
 * built, and `tools.apply` runs the shared apply on the items the user
 * approved, answering one result record per item. `/mcp` keeps the one-call
 * runner (`writeCall.ts`), unchanged.
 *
 * Prepare: the credential, then the shared prepare on the call's signal (the
 * caller's cancel and `PREPARE_DEADLINE_MS`). A refusal is the D-W2 text the
 * one-call runner gives its prepare, never an upstream body. The items must
 * pass the closed proposal check and fit `PROPOSAL_MAX_BYTES`; the warnings
 * are vetted and capped; and the answer as sent must carry no secret form.
 *
 * Apply, in order: the credential, the site the proposal was made for, the
 * closed check of the approved items, then the effects ledger and the shared
 * apply. Every refusal comes before any Atlassian request. The request signal
 * aborts only at `WRITE_DEADLINE_MS`: a cancel never aborts a running
 * request, it makes `stopBefore` answer `STOPPED`, so no further item starts
 * (P6-O1). The ledger certifies effects: an item is `possible` once one of
 * its writes was handed to `fetch`, whatever Atlassian then answered.
 *
 * The answer's budget (P6-F3): the product's shrink stages while the answer
 * is over `RESULT_MAX_BYTES`, then the check of the answer as sent (degraded
 * records, then a fixed failure, each keeping every effects entry), then the
 * host's final byte guard, which never lets an over-cap answer leave.
 */
import { PROPOSAL_MAX_BYTES, jsonBytes } from "../mutationCheckRules.ts";
import {
  WARNING_FALLBACK,
  type Effects,
  type ResultVetting,
} from "../mutationResultCodec.ts";
import type { ApplyHooks } from "../writeScope.ts";
import {
  ToolError,
  abortError,
  raceAbort,
  type ApplyContext,
  type AtlassianCredential,
  type ToolContext,
} from "./descriptor.ts";
import type { ToolFailureCode } from "./host.ts";
import { carriesSecret } from "./upstreamText.ts";
import {
  PREPARE_REFUSAL_MAX,
  STOP_CUTOFF_MS,
  STOP_TEXT,
  type WriteProduct,
} from "./writeCall.ts";
import { projectText, sentResult } from "./writeResult.ts";

/** `tools.prepare`'s deadline, for the whole method. */
export const PREPARE_DEADLINE_MS = 30_000;
/** The serialized `tools.apply` answer's ceiling, in UTF-8 bytes. */
export const RESULT_MAX_BYTES = 524_288;
/**
 * The serialized `tools.prepare` answer's ceiling: the items' own cap plus
 * room for ten vetted warnings, the site and the envelope.
 */
export const PREPARE_ANSWER_MAX_BYTES = PROPOSAL_MAX_BYTES + 32_768;

export const TWO_PHASE_ONLY =
  "This tool runs in two phases on a client connection: tools.prepare, then tools.apply after approval.";
export const PROPOSAL_TOO_LARGE =
  "The proposal is too large for the gateway; split it into smaller changes.";
export const SITE_CHANGED =
  "The gateway's Atlassian site changed since this proposal was prepared; nothing was written. Ask for a new proposal.";
export const ITEMS_INVALID =
  "The approved items are not a valid proposal for this tool; nothing was written.";
export const STOPPED =
  "Not applied: the request ended before this change started.";
export const RESULT_TOO_LARGE =
  "The gateway's result was too large to return; check the site before asking again.";
/** Prepare built items its own check refuses: an edge fault, not the caller's. */
export const PROPOSAL_INVALID =
  "The gateway could not build a valid proposal for these changes; nothing was written.";
/** The prepare answer as sent would carry credential material. */
export const PROPOSAL_WITHHELD =
  "The proposal cannot be shown without revealing the credential; nothing was written.";
/** Not even the degraded records can be sent without credential material. */
export const RESULT_WITHHELD =
  "The changes ran, but their result cannot be shown without revealing the credential; check the site before asking again.";

const PREPARE_WARNINGS_MAX = 10;
const PREPARE_WARNING_MAX = 300;

interface Failure {
  ok: false;
  code: ToolFailureCode;
  message: string;
}

/** What `tools.prepare` answers on success, besides `ok`. */
export interface PreparedProposal {
  /** The credential's site: `tools.apply` must name it again. */
  site: string;
  /** Exactly what the shared prepare built; card data. */
  items: unknown[];
  warnings: string[];
}

export type PrepareAnswer = ({ ok: true } & PreparedProposal) | Failure;

/** `tools.apply`'s request, as decoded; the items are checked here. */
export interface ApplyRequest {
  site: string;
  items: unknown[];
}

/** Any product's result record (`jiraMutationResult.ts`, `confluenceMutationResult.ts`). */
interface ApplyRecord {
  effects: Effects;
}

/**
 * `tools.apply`'s answer. A failure keeps the ledger's root `effects`, and
 * `itemEffects`, each item's in order, once the ledger began.
 */
export type ApplyAnswer =
  | { ok: true; results: ApplyRecord[]; effects: Effects; trimmed?: true }
  | (Failure & { effects: Effects; itemEffects?: Effects[] });

/**
 * One apply's effects ledger (P6-F4). The shared applies call its hooks
 * (`writeScope.ts`): `startItem` before each item, `beforeWrite` just before
 * each write request is handed to `fetch`. A write before the first item
 * counts for the root alone.
 */
export interface WriteLedger {
  readonly hooks: Required<Pick<ApplyHooks, "startItem" | "beforeWrite">>;
  /** Called once the approved items passed their check. */
  begin(count: number): void;
  item(index: number): Effects;
  /** `possible` once any write was marked. */
  root(): Effects;
  /** Each item's effects in order, once begun. */
  items(): Effects[] | undefined;
}

export function createWriteLedger(): WriteLedger {
  let marks: Effects[] | undefined;
  let current = -1;
  let wrote = false;
  return {
    hooks: {
      startItem(index) {
        current = index;
      },
      beforeWrite() {
        wrote = true;
        if (marks && current >= 0 && current < marks.length)
          marks[current] = "possible";
      },
    },
    begin(count) {
      marks = Array.from({ length: count }, (): Effects => "none");
    },
    item: (index) => marks?.[index] ?? "none",
    root: () => (wrote ? "possible" : "none"),
    items: () => (marks ? [...marks] : undefined),
  };
}

/** A product's prepare phase. */
export interface PrepareProduct<Config, Item> extends Pick<
  WriteProduct<Config>,
  "nothingWritten" | "prepareRefusalFallback" | "configOf" | "describeError"
> {
  prepare(
    config: Config,
    credential: AtlassianCredential,
    signal: AbortSignal,
  ): Promise<{ items: Item[]; warnings: string[] }>;
  /** The closed proposal check (`*MutationCheck.ts`). */
  check(items: unknown): items is Item[];
}

/** What the runner hands a product's shared apply. */
interface ApplyDeps extends Required<
  Pick<ApplyHooks, "startItem" | "beforeWrite">
> {
  signal: AbortSignal;
  stopBefore: () => string | undefined;
}

/** A product's apply phase and its result contract. */
export interface ApplyProduct<
  Config,
  Item,
  Rec extends ApplyRecord,
> extends Pick<WriteProduct<Config>, "configOf" | "isAllFailed"> {
  check(items: unknown): items is Item[];
  /** The shared apply, writing its results onto `items`. */
  apply(
    config: Config,
    credential: AtlassianCredential,
    items: Item[],
    deps: ApplyDeps,
  ): Promise<unknown>;
  /** A fresh vetting for this call (`mutationResultVetting.ts`). */
  vetting(credential: AtlassianCredential): ResultVetting;
  record(applied: Item, sent: Item, vet: ResultVetting, effects: Effects): Rec;
  /** The shrink stages, each only while `fits` is false; answers `trimmed`. */
  shrink(records: Rec[], fits: () => boolean, vet: ResultVetting): boolean;
  /**
   * A record with every text fixed and no identifier or link: its effects,
   * nested outcomes and which texts were present stay.
   */
  outcomeOf(record: Rec): Rec;
}

/** Ten vetted warnings at most, the last saying how many more were left out. */
function preparedWarnings(
  warnings: readonly string[],
  credential: AtlassianCredential,
): string[] {
  const over = warnings.length > PREPARE_WARNINGS_MAX;
  const shown = over ? warnings.slice(0, PREPARE_WARNINGS_MAX - 1) : warnings;
  const vetted = shown.map((warning) =>
    projectText(warning, credential, PREPARE_WARNING_MAX, WARNING_FALLBACK),
  );
  if (over)
    vetted.push(
      `${warnings.length - shown.length} more warning(s) were left out.`,
    );
  return vetted;
}

/** Runs one `tools.prepare`: what the host answers as `{ok: true, ...}`. */
export async function runPrepare<Config, Item>(
  ctx: ToolContext<AtlassianCredential>,
  product: PrepareProduct<Config, Item>,
): Promise<PreparedProposal> {
  // Nothing goes upstream before the credential is here.
  const credential = await ctx.credential();
  const config = product.configOf(credential);
  if (ctx.signal.aborted) throw abortError();
  let prepared: { items: Item[]; warnings: string[] };
  try {
    prepared = await raceAbort(
      product.prepare(config, credential, ctx.signal),
      ctx.signal,
    );
  } catch (err) {
    // The host classifies an abort by its signals.
    if (ctx.signal.aborted) throw err;
    throw new ToolError(
      projectText(
        product.describeError(err, credential, [ctx.signal]) +
          product.nothingWritten,
        credential,
        PREPARE_REFUSAL_MAX,
        product.prepareRefusalFallback,
      ),
    );
  }
  const bytes = jsonBytes(prepared.items);
  if (bytes === undefined || bytes > PROPOSAL_MAX_BYTES)
    throw new ToolError(PROPOSAL_TOO_LARGE);
  if (!product.check(prepared.items)) throw new ToolError(PROPOSAL_INVALID);
  const proposal: PreparedProposal = {
    site: credential.site,
    items: prepared.items,
    warnings: preparedWarnings(prepared.warnings, credential),
  };
  // The answer as sent, and as the frame escapes it once more.
  if (carriesSecret(JSON.stringify(proposal), credential))
    throw new ToolError(PROPOSAL_WITHHELD);
  return proposal;
}

/** Runs one `tools.apply` after its gates. */
export async function runApply<Config, Item, Rec extends ApplyRecord>(
  ctx: ApplyContext,
  product: ApplyProduct<Config, Item, Rec>,
  request: ApplyRequest,
): Promise<ApplyAnswer> {
  const credential = await ctx.credential();
  if (request.site !== credential.site) throw new ToolError(SITE_CHANGED);
  const sent: unknown = request.items;
  if (!product.check(sent))
    throw new ToolError(ITEMS_INVALID, "invalid_params");
  // Apply writes its results onto its own copy; the request stays as sent.
  const working = structuredClone(sent);
  const config = product.configOf(credential);
  if (ctx.signal.aborted) throw abortError();

  const { ledger } = ctx;
  ledger.begin(working.length);
  const stopAt = ctx.deadlineAt - STOP_CUTOFF_MS;
  try {
    await product.apply(config, credential, working, {
      ...ledger.hooks,
      signal: ctx.signal,
      stopBefore: () => {
        if (ctx.cancel.aborted) return STOPPED;
        return Date.now() > stopAt ? STOP_TEXT : undefined;
      },
    });
  } catch (err) {
    // Every item failed: still records, each with its own error.
    if (ctx.signal.aborted || !product.isAllFailed(err)) throw err;
  }

  const vet = product.vetting(credential);
  const records = working.map((item, index) =>
    product.record(item, sent[index]!, vet, ledger.item(index)),
  );
  const effects = ledger.root();
  const answerOf = (shown: Rec[], trimmed: boolean): ApplyAnswer => ({
    ok: true,
    results: shown,
    effects,
    ...(trimmed ? { trimmed: true } : {}),
  });
  // Measured with `trimmed`, as the answer would leave once a stage ran.
  const fits = () =>
    (jsonBytes(answerOf(records, true)) ?? Infinity) <= RESULT_MAX_BYTES;
  const trimmed = product.shrink(records, fits, vet);
  try {
    return sentResult(
      answerOf(records, trimmed),
      credential,
      () => answerOf(records.map(product.outcomeOf), true),
      RESULT_WITHHELD,
    );
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return {
      ok: false,
      code: "failed",
      message: err.message,
      effects,
      itemEffects: records.map((record) => record.effects),
    };
  }
}

/**
 * The final guard: an apply answer over `RESULT_MAX_BYTES` never leaves; the
 * bounded failure keeps its effects, each item's included.
 */
export function applyAnswerWithinCap(
  answer: ApplyAnswer,
  onOver: () => void,
): ApplyAnswer {
  const bytes = jsonBytes(answer);
  if (bytes !== undefined && bytes <= RESULT_MAX_BYTES) return answer;
  onOver();
  const itemEffects = answer.ok
    ? answer.results.map((record) => record.effects)
    : answer.itemEffects;
  return {
    ok: false,
    code: "failed",
    message: RESULT_TOO_LARGE,
    effects: answer.effects,
    ...(itemEffects ? { itemEffects } : {}),
  };
}

/** The same guard for a prepare answer, over `PREPARE_ANSWER_MAX_BYTES`. */
export function prepareAnswerWithinCap(answer: PrepareAnswer): PrepareAnswer {
  const bytes = jsonBytes(answer);
  if (bytes !== undefined && bytes <= PREPARE_ANSWER_MAX_BYTES) return answer;
  return { ok: false, code: "tool_error", message: PROPOSAL_TOO_LARGE };
}
