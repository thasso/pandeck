/**
 * `jira_mutate_issue` on the edge (Task-1463 P4b2): the local tool's schema
 * structure and shared prepare/apply core (`jiraMutate.ts`,
 * `jiraMutateApply.ts`), run with the calling user's Atlassian credential. On
 * `/mcp` the harness's own permission prompt approves the call (D-W), so one
 * call prepares and applies at once; Pandeck's client mode still drops write
 * entries (`remoteTools.ts`).
 *
 * One call, under the tool's own 45 s deadline (derived from Claude Code's
 * measured 60 s MCP tool-call limit), run by the shared write runner
 * (`writeCall.ts`): the credential, then prepare under a guarded budget that
 * ends before the deadline, then apply on the call's own signal, which stops
 * starting items shortly before the deadline. Only after the budget's phase
 * is over, and only through the fence before apply, can a write start.
 * Failures follow D-W2 (`writeFailure.ts`). The result is a compact
 * projection whose serialized size is bounded by construction; identifiers
 * and links pass only when vetted for the call's secret on their raw values
 * (`writeResult.ts`).
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
import { checkJiraIssueItems } from "../jiraMutationCheck.ts";
import { JiraMutationError } from "../jiraMutationErrors.ts";
import {
  buildJiraResultRecord,
  shrinkJiraResults,
  type JiraResultRecord,
} from "../jiraMutationResult.ts";
import {
  ERROR_FALLBACK,
  IDENTIFIER_FORMATS,
  WARNING_FALLBACK,
  type NestedResults,
} from "../mutationResultCodec.ts";
import { jiraConfigOf } from "./atlassian.ts";
import type {
  AtlassianCredential,
  AtlassianToolDescriptor,
  ObjectSchema,
} from "./descriptor.ts";
import { edgeReadDeps } from "./jiraRead.ts";
import { vettingFor } from "./mutationResultVetting.ts";
import {
  runApply,
  runPrepare,
  type ApplyProduct,
  type PrepareProduct,
} from "./twoPhase.ts";
import { REDACTED } from "./upstreamText.ts";
import {
  WRITE_DEADLINE_MS,
  runWrite,
  type WritePhases,
  type WriteProduct,
} from "./writeCall.ts";
import { describeWriteFailure } from "./writeFailure.ts";
import {
  RESULT_BUDGET,
  projectText,
  sentResult,
  shrunkToBudget,
  vettedIdentifier,
  vettedUrl,
} from "./writeResult.ts";

export { STOP_TEXT, WRITE_DEADLINE_MS } from "./writeCall.ts";
export { RESULT_BUDGET } from "./writeResult.ts";

export const PREPARE_TOO_LONG =
  "Preparing the changes took too long; nothing was written to Jira. Send fewer items or fewer issues per item.";
const NOTHING_WRITTEN = " Nothing was written to Jira.";
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

/** An identifier as Jira returned it, kept only whole, vetted and well-formed. */
function vettedKey(
  raw: unknown,
  credential: AtlassianCredential,
): string | undefined {
  return vettedIdentifier(raw, credential, IDENTIFIER_FORMATS.jiraKey);
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
  const kept = shrunkToBudget(
    result,
    budget,
    jiraShrinkStages(
      applied.warnings.length,
      projectText(counts, credential, SUMMARY_MAX, REDACTED),
      credential,
    ),
  );
  return sentResult(
    kept,
    credential,
    (sent) => ({
      summary: REDACTED,
      items: sent.items.map(({ operation, ok }) => ({
        operation,
        issueKey: null,
        ok,
      })),
    }),
    RESULT_WITHHELD,
  );
}

/**
 * Jira's shrink stages, in order (P4b2): the warnings to one fixed entry; row
 * texts to 200; the summary to the counts; every link dropped. A row's
 * operation, key, outcome and created key are never removed.
 */
function jiraShrinkStages(
  warningCount: number,
  counts: string,
  credential: AtlassianCredential,
): ((result: ProjectedResult) => void)[] {
  return [
    (result) => {
      if (result.warnings)
        result.warnings = [
          projectText(
            `${warningCount} warning(s) omitted.`,
            credential,
            WARNING_MAX,
            REDACTED,
          ),
        ];
    },
    (result) => {
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
    },
    (result) => {
      result.summary = counts;
    },
    (result) => {
      delete result.url;
      for (const item of result.items) delete item.url;
    },
  ];
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

type JiraConfig = ReturnType<typeof jiraConfigOf>;
type JiraPrepared = Awaited<ReturnType<typeof buildJiraMutationItems>>;
type JiraApplied = Awaited<ReturnType<typeof applyJiraMutationItems>>;

/** Jira's texts, config and D-W2 mapper for the shared runner. */
const JIRA_WRITE: WriteProduct<JiraConfig> = {
  prepareTooLong: PREPARE_TOO_LONG,
  nothingWritten: NOTHING_WRITTEN,
  prepareRefusalFallback: `Jira refused the change.${NOTHING_WRITTEN}`,
  allFailedFallback: "Every Jira change failed.",
  configOf: jiraConfigOf,
  describeError: describeWriteFailure,
  isAllFailed: (err): err is JiraMutationError =>
    err instanceof JiraMutationError,
};

/**
 * One call's phases: prepare's reads on its own signal, apply on the call's;
 * the field list prepare resolved is kept for apply (`callFieldMap`).
 */
function jiraPhases(
  items: JiraMutationParams["items"],
): (
  config: JiraConfig,
  credential: AtlassianCredential,
) => WritePhases<JiraPrepared, JiraApplied> {
  return (config, credential) => {
    const fieldMap = callFieldMap(config);
    return {
      prepare(signal) {
        const read = edgeReadDeps(config, signal);
        return buildJiraMutationItems(config, items ?? [], {
          signal,
          fieldMap: fieldMap.prepare(signal),
          issueLinkTypes: read.issueLinkTypes,
          describeError: (err) =>
            describeWriteFailure(err, credential, [signal]),
          matchesHttpStatus: (err, statuses) =>
            err instanceof AtlassianHttpError && statuses.includes(err.status),
        });
      },
      apply(prepared, signal, stopBefore) {
        return applyJiraMutationItems(config, prepared.items, {
          signal,
          fieldMap: fieldMap.apply(signal),
          describeError: (err) =>
            describeWriteFailure(err, credential, [signal]),
          stopBefore,
        });
      },
    };
  };
}

/** Jira's prepare for `tools.prepare`: the one-call prepare, on its own. */
const JIRA_PREPARE = (
  items: JiraMutationParams["items"],
): PrepareProduct<JiraConfig, JiraIssueMutationItemDisplay> => ({
  ...JIRA_WRITE,
  prepare: (config, credential, signal) =>
    jiraPhases(items)(config, credential).prepare(signal),
  check: checkJiraIssueItems,
});

/** A nested result with its texts emptied; outcomes and presence stay. */
const blanked = (results: NestedResults): NestedResults => ({
  ok: results.ok,
  errors: results.errors.map(([index]): [number, string] => [index, ""]),
});

/**
 * A record with every text fixed and no identifier, link, order or sprint
 * result: what `tools.apply` sends when the full records would carry a
 * secret form once joined.
 */
export function jiraOutcomeOf(record: JiraResultRecord): JiraResultRecord {
  return {
    effects: record.effects,
    ...(record.resultIssueKey !== undefined ? { resultIssueKey: null } : {}),
    ...(record.resultIssueUrl === null ? { resultIssueUrl: null } : {}),
    ...(record.warning !== undefined ? { warning: WARNING_FALLBACK } : {}),
    ...(record.error !== undefined ? { error: ERROR_FALLBACK } : {}),
    ...(record.linkChanges ? { linkChanges: blanked(record.linkChanges) } : {}),
    ...(record.rankSteps ? { rankSteps: blanked(record.rankSteps) } : {}),
  };
}

/** Jira's apply for `tools.apply`: the shared apply and its result contract. */
const JIRA_APPLY: ApplyProduct<
  JiraConfig,
  JiraIssueMutationItemDisplay,
  JiraResultRecord
> = {
  ...JIRA_WRITE,
  check: checkJiraIssueItems,
  apply: (config, credential, items, deps) =>
    applyJiraMutationItems(config, items, {
      ...deps,
      fieldMap: callFieldMap(config).apply(deps.signal),
      describeError: (err) =>
        describeWriteFailure(err, credential, [deps.signal]),
    }),
  vetting: vettingFor,
  record: buildJiraResultRecord,
  shrink: shrinkJiraResults,
  outcomeOf: jiraOutcomeOf,
};

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
    const { credential, prepared, applied } = await runWrite(
      ctx,
      JIRA_WRITE,
      jiraPhases((params as JiraMutationParams).items),
    );
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
  phases: {
    prepare: (params, ctx) =>
      runPrepare(ctx, JIRA_PREPARE((params as JiraMutationParams).items)),
    apply: (request, ctx) => runApply(ctx, JIRA_APPLY, request),
  },
};
