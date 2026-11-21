/**
 * `jira_mutate_issue` on the edge (Task-1463 P4b2): the local tool's schema
 * structure and shared prepare/apply core (`jiraMutate.ts`,
 * `jiraMutateApply.ts`), run with the calling user's Atlassian credential. On
 * `/mcp` the harness's own permission prompt approves the call (D-W), so one
 * call prepares and applies at once; Pandeck's client mode still drops write
 * entries (`remoteTools.ts`).
 *
 * One call, under the tool's own 45 s deadline (derived from Claude Code's
 * measured 60 s MCP tool-call limit): the credential, then prepare under a
 * guarded budget that ends `PREPARE_RESERVE_MS` before the deadline, then
 * apply on the call's own signal, which stops starting items
 * `STOP_CUTOFF_MS` before the deadline. Only after the budget's phase is
 * over, and only through the fence before apply, can a write start. Failures
 * follow D-W2 (`writeFailure.ts`). The result is a compact projection whose
 * serialized size is bounded by construction; identifiers and links pass only
 * when vetted for the call's secret on their raw values.
 *
 * A `notifications/cancelled` on another POST does not reach the call (the
 * handler is stateless per POST), so an interrupted write runs to completion
 * or its deadline; the description says so.
 */
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { AtlassianHttpError } from "../atlassian/atlassianFetch.ts";
import type { JiraFieldMap } from "../jiraFields.ts";
import {
  buildJiraMutationItems,
  mutateIssueParamsSchema,
  type JiraMutationParams,
} from "../jiraMutate.ts";
import { applyJiraMutationItems } from "../jiraMutateApply.ts";
import { JiraMutationError } from "../jiraMutationErrors.ts";
import { jiraConfigOf } from "./atlassian.ts";
import {
  ToolError,
  abortError,
  raceAbort,
  type AtlassianCredential,
  type AtlassianToolDescriptor,
  type ObjectSchema,
} from "./descriptor.ts";
import { edgeReadDeps } from "./jiraRead.ts";
import { holdsSecret, leaks, REDACTED, vettedText } from "./upstreamText.ts";
import { describeWriteFailure } from "./writeFailure.ts";

/** The call's deadline: the measured 60 s client limit less 15 s. */
export const WRITE_DEADLINE_MS = 45_000;
/** The part of the deadline prepare never takes: apply's share. */
const PREPARE_RESERVE_MS = 22_000;
/** Apply starts no item this close to the deadline. */
const STOP_CUTOFF_MS = 7_000;
/** The projected result's serialized ceiling, under `maxResultChars`. */
export const RESULT_BUDGET = 55_000;

export const PREPARE_TOO_LONG =
  "Preparing the changes took too long; nothing was written to Jira. Send fewer items or fewer issues per item.";
export const STOP_TEXT =
  "Not applied: the call ran out of time before this change; nothing was sent for it.";
const NOTHING_WRITTEN = " Nothing was written to Jira.";
/** Above any prepare refusal (D-W2 caps its own texts at 1,000). */
const PREPARE_REFUSAL_MAX = 1_200;
const PREPARE_REFUSAL_FALLBACK = `Jira refused the change.${NOTHING_WRITTEN}`;
const ALL_FAILED_MAX = 2_000;
const ALL_FAILED_FALLBACK = "Every Jira change failed.";
/** When not even the rows' outcomes can be shown without the credential (R3). */
export const RESULT_WITHHELD =
  "The changes ran, but their result cannot be shown without revealing the credential; check the issues before retrying.";

const SUMMARY_MAX = 4_000;
const WARNINGS_MAX = 20;
const WARNING_MAX = 300;
const ITEM_ERROR_MAX = 800;
const ITEM_WARNING_MAX = 500;
const SHRUNK_TEXT_MAX = 200;
const WARNING_WITHHELD = "A warning was withheld.";
const ITEM_ERROR_FALLBACK = "The change failed.";

const KEY_RE = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
const KEY_MAX = 64;
const URL_MAX = 300;
/** Printable ASCII without space; `"` and `\` are refused separately. */
const URL_CHARS_RE = /^[\x21-\x7e]+$/;
const URL_DECODE_ROUNDS = 3;

const OPERATIONS = ["edit", "create", "comment", "rank", "sprint"] as const;
type Operation = (typeof OPERATIONS)[number];

const JIRA_MUTATE_ISSUE_EDGE_DESCRIPTION =
  "Change Jira issues: create tickets and sub-tasks, edit fields and Markdown content, add Markdown comments, add or remove issue links, rank backlogs and edit sprints. CommonMark/GFM is converted to Atlassian Document Format. This tool writes in one call: the client asks the user to approve it, and Jira changes as soon as it runs. Set item.operation to edit (default), create, comment, rank, or sprint; rank reorders a backlog through Jira's Agile ranking API, not the opaque rank field; sprint edits a sprint's name, dates or goal. Use it only when the user explicitly asks for the change, and ask first when the target issue or value is ambiguous. On create, confirm project and issue type with the user; never set the Cost Center, which Jira automation derives from the ticket. Keep batches small. Interrupting the call does not stop it; it may still be writing. After a timeout or interrupt, wait 60 s before reading the issues and before any retry: an early unchanged read does not prove nothing will change.";

const localItems = mutateIssueParamsSchema.properties.items;
const localItem = localItems.items;

/**
 * The local schema with four prose changes (I1): where the local tool stages
 * an approval card, this one writes. Built by spreading, so the structure is
 * the local one.
 */
const edgeMutateIssueParamsSchema = {
  ...mutateIssueParamsSchema,
  properties: {
    ...mutateIssueParamsSchema.properties,
    items: {
      ...localItems,
      description: "Jira issue changes, applied in this call.",
      items: {
        ...localItem,
        properties: {
          ...localItem.properties,
          projectKey: {
            ...localItem.properties.projectKey,
            description: "create: project key for the new issue, e.g. OPS.",
          },
          fields: {
            ...localItem.properties.fields,
            description:
              "Advanced field updates keyed by Jira field id or name. Values are sent as Jira REST field values.",
          },
        },
      },
    },
  },
} satisfies ObjectSchema;

/** One row of the projected result. */
interface ProjectedItem {
  operation: Operation;
  issueKey: string | null;
  ok: boolean;
  url?: string;
  createdKey?: string;
  warning?: string;
  error?: string;
}

/** The answer of a call that reached apply. */
export interface ProjectedResult {
  summary: string;
  url?: string;
  warnings?: string[];
  items: ProjectedItem[];
}

/**
 * Caller-visible text (`vettedText`): each secret piece as `[redacted]`,
 * controls as spaces, lone surrogates replaced, cut to `max`, and the result
 * itself checked. Its JSON form is at most 2 × max + 2.
 */
function projectText(
  text: string,
  credential: AtlassianCredential,
  max: number,
  fallback: string,
): string {
  return vettedText(text, credential, { max, fallback });
}

/** An identifier as Jira returned it, kept only whole, vetted and well-formed. */
function vettedKey(
  raw: unknown,
  credential: AtlassianCredential,
): string | undefined {
  if (typeof raw !== "string" || holdsSecret(raw, credential)) return undefined;
  return raw.length <= KEY_MAX && KEY_RE.test(raw) ? raw : undefined;
}

/**
 * A link, kept only when its backing identifier passed, it lies on the
 * credential's site, its raw form is short printable ASCII without `"` or
 * `\`, and neither it nor any of up to three successive percent-decodings
 * holds the secret. A decoding error, or a form still changing after the
 * third decoding, omits it.
 */
function vettedUrl(
  raw: unknown,
  backingKey: string | undefined,
  credential: AtlassianCredential,
): string | undefined {
  if (backingKey === undefined || typeof raw !== "string") return undefined;
  if (holdsSecret(raw, credential)) return undefined;
  if (
    !raw.startsWith(`https://${credential.site}/`) ||
    raw.length > URL_MAX ||
    !URL_CHARS_RE.test(raw) ||
    raw.includes('"') ||
    raw.includes("\\")
  )
    return undefined;
  let form = raw;
  for (let round = 0; round <= URL_DECODE_ROUNDS; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(form);
    } catch {
      return undefined;
    }
    if (decoded === form) return raw;
    // Past the third decoding the form is still changing: not vetted.
    if (round === URL_DECODE_ROUNDS) return undefined;
    if (holdsSecret(decoded, credential)) return undefined;
    form = decoded;
  }
  return undefined;
}

function operationOf(item: JiraIssueMutationItemDisplay): Operation {
  const operation = item.operation ?? "edit";
  return (OPERATIONS as readonly string[]).includes(operation)
    ? (operation as Operation)
    : "edit";
}

/**
 * The applied items as the caller's answer: every string capped and vetted,
 * keys and links vetted on their raw values. A shrink guard keeps the
 * serialized result within `budget` (unreachable at these caps) in a fixed
 * order, never removing a row's operation, key, outcome or created key.
 */
export function projectMutationResult(
  applied: {
    items: readonly JiraIssueMutationItemDisplay[];
    warnings: readonly string[];
    succeeded: number;
    resultSummary: string;
    resultUrl?: string | undefined;
  },
  credential: AtlassianCredential,
  budget = RESULT_BUDGET,
): ProjectedResult {
  const failed = applied.items.length - applied.succeeded;
  const counts = `Applied ${applied.succeeded} change(s); ${failed} failed.`;
  const items = applied.items.map((item): ProjectedItem => {
    const issueKey = vettedKey(item.issueKey, credential);
    const url = vettedUrl(item.resultIssueUrl, issueKey, credential);
    const createdKey =
      item.operation === "create"
        ? vettedKey(item.resultIssueKey, credential)
        : undefined;
    return {
      operation: operationOf(item),
      issueKey: issueKey ?? null,
      ok: typeof item.error !== "string",
      ...(url !== undefined ? { url } : {}),
      ...(createdKey !== undefined ? { createdKey } : {}),
      ...(typeof item.warning === "string"
        ? {
            warning: projectText(
              item.warning,
              credential,
              ITEM_WARNING_MAX,
              WARNING_WITHHELD,
            ),
          }
        : {}),
      ...(typeof item.error === "string"
        ? {
            error: projectText(
              item.error,
              credential,
              ITEM_ERROR_MAX,
              ITEM_ERROR_FALLBACK,
            ),
          }
        : {}),
    };
  });
  // The root link is the first item's link, backed by that item's key.
  const source = applied.items.find((item) => item.resultIssueUrl);
  const url = vettedUrl(
    applied.resultUrl,
    source ? vettedKey(source.issueKey, credential) : undefined,
    credential,
  );
  const warnings = applied.warnings
    .slice(0, WARNINGS_MAX)
    .map((warning) =>
      projectText(warning, credential, WARNING_MAX, WARNING_WITHHELD),
    );
  if (applied.warnings.length > WARNINGS_MAX)
    warnings.push(
      projectText(
        `${applied.warnings.length - WARNINGS_MAX} more warning(s) omitted.`,
        credential,
        WARNING_MAX,
        REDACTED,
      ),
    );
  const result: ProjectedResult = {
    summary: projectText(
      applied.resultSummary,
      credential,
      SUMMARY_MAX,
      counts,
    ),
    ...(url !== undefined ? { url } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    items,
  };
  const kept = shrunk(
    result,
    applied.warnings.length,
    projectText(counts, credential, SUMMARY_MAX, REDACTED),
    credential,
    budget,
  );
  // The answer as it is sent, and as the `/mcp` body or `tools.call` frame
  // escapes it once more (fix-2, fix-4): should joining its strings into JSON
  // make a secret, only the rows' outcomes remain; should even those (R3), a
  // fixed text.
  if (!leaks(JSON.stringify(kept), credential, 1)) return kept;
  const outcomes: ProjectedResult = {
    summary: REDACTED,
    items: kept.items.map(({ operation, ok }) => ({
      operation,
      issueKey: null,
      ok,
    })),
  };
  if (!leaks(JSON.stringify(outcomes), credential, 1)) return outcomes;
  throw new ToolError(RESULT_WITHHELD);
}

/**
 * The guard: each step only when the result is still over the budget. A text
 * it cuts further is vetted again (`projectText`), so a cut never splits a
 * placeholder or makes a secret.
 */
function shrunk(
  result: ProjectedResult,
  warningCount: number,
  counts: string,
  credential: AtlassianCredential,
  budget: number,
): ProjectedResult {
  const over = (): boolean => JSON.stringify(result).length > budget;
  if (over() && result.warnings)
    result.warnings = [
      projectText(
        `${warningCount} warning(s) omitted.`,
        credential,
        WARNING_MAX,
        REDACTED,
      ),
    ];
  if (over())
    for (const item of result.items) {
      if (item.warning !== undefined)
        item.warning = projectText(
          item.warning,
          credential,
          SHRUNK_TEXT_MAX,
          WARNING_WITHHELD,
        );
      if (item.error !== undefined)
        item.error = projectText(
          item.error,
          credential,
          SHRUNK_TEXT_MAX,
          ITEM_ERROR_FALLBACK,
        );
    }
  if (over()) result.summary = counts;
  if (over()) {
    delete result.url;
    for (const item of result.items) delete item.url;
  }
  return result;
}

/**
 * The field list for one call: prepare's read keeps its resolved value in the
 * call's memory for apply, which reads it again on its own signal only when
 * prepare never needed it.
 */
function callFieldMap(config: ReturnType<typeof jiraConfigOf>) {
  let value: JiraFieldMap | undefined;
  let pending: Promise<JiraFieldMap> | undefined;
  return {
    prepare(signal: AbortSignal): () => Promise<JiraFieldMap> {
      const read = edgeReadDeps(config, signal);
      return () => {
        if (value) return Promise.resolve(value);
        pending ??= read.fieldMap().then(
          (map) => (value = map),
          (err: unknown) => {
            pending = undefined;
            throw err;
          },
        );
        return pending;
      };
    },
    apply(signal: AbortSignal): () => Promise<JiraFieldMap> {
      return async () =>
        (value ??= await edgeReadDeps(config, signal).fieldMap());
    },
  };
}

export const jiraMutateIssue: AtlassianToolDescriptor = {
  name: "jira_mutate_issue",
  description: JIRA_MUTATE_ISSUE_EDGE_DESCRIPTION,
  inputSchema: edgeMutateIssueParamsSchema,
  effect: "write",
  actionKey: "jira:write",
  integration: "atlassian",
  maxResultChars: 60_000,
  deadlineMs: WRITE_DEADLINE_MS,
  async execute(params, ctx) {
    // Nothing goes upstream before the credential is here.
    const credential = await ctx.credential();
    const config = jiraConfigOf(credential);
    if (ctx.signal.aborted) throw abortError();
    const prepareEndsAt = ctx.deadlineAt - PREPARE_RESERVE_MS;
    const budgetMs = prepareEndsAt - Date.now();
    if (budgetMs <= 0) throw new ToolError(PREPARE_TOO_LONG);

    const fieldMap = callFieldMap(config);
    const budget = new AbortController();
    const prepareSignal = AbortSignal.any([ctx.signal, budget.signal]);
    const read = edgeReadDeps(config, prepareSignal);
    let prepared: Awaited<ReturnType<typeof buildJiraMutationItems>>;
    const timer = setTimeout(() => budget.abort(), budgetMs);
    try {
      prepared = await raceAbort(
        buildJiraMutationItems(
          config,
          (params as JiraMutationParams).items ?? [],
          {
            signal: prepareSignal,
            fieldMap: fieldMap.prepare(prepareSignal),
            issueLinkTypes: read.issueLinkTypes,
            describeError: (err) =>
              describeWriteFailure(err, credential, [prepareSignal]),
            matchesHttpStatus: (err, statuses) =>
              err instanceof AtlassianHttpError &&
              statuses.includes(err.status),
          },
        ),
        prepareSignal,
      );
    } catch (err) {
      // By the prepare phase's own signals, the caller's first.
      if (ctx.signal.aborted) throw err;
      if (budget.signal.aborted) throw new ToolError(PREPARE_TOO_LONG);
      // The joined text is what leaves, so it is what is vetted (fix-2).
      throw new ToolError(
        projectText(
          describeWriteFailure(err, credential, [prepareSignal]) +
            NOTHING_WRITTEN,
          credential,
          PREPARE_REFUSAL_MAX,
          PREPARE_REFUSAL_FALLBACK,
        ),
      );
    } finally {
      clearTimeout(timer);
    }
    // The fence: a prepare that settled at or after its budget never writes,
    // even when the budget's timer callback has not run yet.
    if (ctx.signal.aborted) throw abortError();
    if (budget.signal.aborted || Date.now() >= prepareEndsAt)
      throw new ToolError(PREPARE_TOO_LONG);

    const stopAt = ctx.deadlineAt - STOP_CUTOFF_MS;
    let applied: Awaited<ReturnType<typeof applyJiraMutationItems>>;
    try {
      applied = await applyJiraMutationItems(config, prepared.items, {
        signal: ctx.signal,
        fieldMap: fieldMap.apply(ctx.signal),
        describeError: (err) =>
          describeWriteFailure(err, credential, [ctx.signal]),
        stopBefore: () => (Date.now() > stopAt ? STOP_TEXT : undefined),
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (err instanceof JiraMutationError)
        throw new ToolError(
          projectText(
            err.message,
            credential,
            ALL_FAILED_MAX,
            ALL_FAILED_FALLBACK,
          ),
        );
      throw err;
    }
    return projectMutationResult(
      {
        items: prepared.items,
        warnings: prepared.warnings,
        succeeded: applied.succeeded,
        resultSummary: applied.resultSummary,
        resultUrl: applied.resultUrl,
      },
      credential,
    );
  },
};
