/**
 * Task 288: the enforced side of the prompt inventory.
 *
 * `promptInventory.ts` measures; this module holds a measurement against the
 * committed budgets in `config/prompt-budgets.json` and renders the size
 * snapshot that makes a prompt edit show up as a per-layer delta in review.
 * Every number comes from the config: this file owns the rules, never the
 * values — the same split as `scripts/check-instruction-docs.mjs` (Task 275).
 *
 * ## A budget is a tripwire, not a target
 *
 * Budgets exist so that growth is DELIBERATE and visible, not so that a prompt
 * can never grow. Text that earns its characters should be written; the raise
 * that admits it is a one-line edit to the config plus a `raises` entry saying
 * why. The failure message says so, and `docs/prompt-budgets.md` spells out
 * when raising is the right answer.
 *
 * ## Why the measurement is normalized
 *
 * Budgets and snapshots are asserted in CI, so the measured numbers may not
 * depend on where the repository sits: the inventory runs against this
 * checkout's tracked `config/prompts` with `cwdLabel` (the cwd lands in the
 * prompt twice — pi's own cwd line and the `<project_context>` file path — so a
 * real checkout path costs ~2 characters per character of it), and with every
 * conditional section ON, so a budget bounds the worst case OVER CONDITIONS at
 * that normalized path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_TYPES } from "./agentTypes.ts";
import type { AgentType } from "@assistant/shared";
import { gitOptional } from "./gitExec.ts";
import { PI_PACKAGE_LABEL } from "./piSdk/piPromptMeasure.ts";
import {
  INVENTORY_HARNESSES,
  promptInventory,
  REPO_PROMPTS_DIR,
  REPO_ROOT,
  type InventoryHarness,
  type InventoryLayer,
  type InventorySection,
  type PersonaInventory,
  type PromptInventoryReport,
} from "./promptInventory.ts";

/** The one committed file holding the numbers. */
export const PROMPT_BUDGETS_PATH = fileURLToPath(
  new URL("../../../config/prompt-budgets.json", import.meta.url),
);

const AGENT_TYPE_LIST = Object.keys(AGENT_TYPES) as AgentType[];
const SECTIONS: InventorySection[] = ["prompt", "tools"];

/**
 * One budgeted quantity, defined as the counted layers it sums. Adding a
 * narrower budget later (say, the tool schemas alone) is a config edit: a new
 * limit with its own selector, plus its numbers.
 */
export interface PromptLimit {
  id: string;
  label: string;
  /** Layer sections this limit sums. */
  sections: InventorySection[];
  /** Optional layer-id patterns (`*` wildcard) narrowing the selection. */
  layers?: string[];
  /** Prose for the report; not enforced. */
  covers?: string;
}

/** A recorded, deliberate change to a budget. */
interface PromptBudgetRaise {
  /** `<persona>.<harness>.<limit>`. */
  budget: string;
  from: number;
  to: number;
  task: string;
  date: string;
  why: string;
}

export interface PromptBudgetsConfig {
  path: string;
  unit: string;
  cwdLabel: string;
  /** Repo-relative path of the size snapshot the test pins. */
  snapshotPath: string;
  warnAtPercentOfBudget: number;
  limits: PromptLimit[];
  budgets: Record<AgentType, Record<InventoryHarness, Record<string, number>>>;
  raises: PromptBudgetRaise[];
}

/** A malformed budget config: never a default, always a loud failure. */
export class PromptBudgetConfigError extends Error {
  constructor(message: string) {
    super(`Invalid prompt budget config: ${message}`);
    this.name = "PromptBudgetConfigError";
  }
}

// --- config -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value))
    throw new PromptBudgetConfigError(`${at} must be an object.`);
  return value;
}

function requireNumber(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new PromptBudgetConfigError(`${at} must be a number.`);
  return value;
}

function requireString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new PromptBudgetConfigError(`${at} must be a non-empty string.`);
  return value;
}

function requireStrings(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    throw new PromptBudgetConfigError(`${at} must be an array of strings.`);
  return value as string[];
}

function parseLimits(value: unknown): PromptLimit[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new PromptBudgetConfigError("`limits` must be a non-empty array.");
  const limits = value.map((entry, index) => {
    const at = `limits[${index}]`;
    const raw = requireRecord(entry, at);
    const sections = requireStrings(raw.sections, `${at}.sections`);
    for (const section of sections)
      if (!SECTIONS.includes(section as InventorySection))
        throw new PromptBudgetConfigError(
          `${at}.sections has unknown section "${section}" (known: ${SECTIONS.join(", ")}).`,
        );
    return {
      id: requireString(raw.id, `${at}.id`),
      label: requireString(raw.label, `${at}.label`),
      sections: sections as InventorySection[],
      ...(raw.layers === undefined
        ? {}
        : { layers: requireStrings(raw.layers, `${at}.layers`) }),
      ...(raw.covers === undefined
        ? {}
        : { covers: requireString(raw.covers, `${at}.covers`) }),
    } satisfies PromptLimit;
  });
  const ids = new Set(limits.map((l) => l.id));
  if (ids.size !== limits.length)
    throw new PromptBudgetConfigError("`limits` has duplicate ids.");
  return limits;
}

function parseBudgets(
  value: unknown,
  limits: PromptLimit[],
): PromptBudgetsConfig["budgets"] {
  const raw = requireRecord(value, "`budgets`");
  for (const persona of Object.keys(raw))
    if (!AGENT_TYPE_LIST.includes(persona as AgentType))
      throw new PromptBudgetConfigError(
        `\`budgets\` has unknown persona "${persona}" (known: ${AGENT_TYPE_LIST.join(", ")}).`,
      );

  const budgets = {} as PromptBudgetsConfig["budgets"];
  for (const persona of AGENT_TYPE_LIST) {
    const perHarness = requireRecord(raw[persona], `budgets.${persona}`);
    for (const harness of Object.keys(perHarness))
      if (!INVENTORY_HARNESSES.includes(harness as InventoryHarness))
        throw new PromptBudgetConfigError(
          `budgets.${persona} has unknown harness "${harness}".`,
        );
    budgets[persona] = {} as Record<InventoryHarness, Record<string, number>>;
    for (const harness of INVENTORY_HARNESSES) {
      const at = `budgets.${persona}.${harness}`;
      const perLimit = requireRecord(perHarness[harness], at);
      for (const id of Object.keys(perLimit))
        if (!limits.some((limit) => limit.id === id))
          throw new PromptBudgetConfigError(`${at} has unknown limit "${id}".`);
      const values: Record<string, number> = {};
      for (const limit of limits) {
        if (!(limit.id in perLimit))
          throw new PromptBudgetConfigError(
            `${at} declares no budget for limit "${limit.id}". Run \`pnpm run check:prompts\` for the measured value.`,
          );
        values[limit.id] = requireNumber(
          perLimit[limit.id],
          `${at}.${limit.id}`,
        );
      }
      budgets[persona][harness] = values;
    }
  }
  return budgets;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

const MIN_RAISE_REASON_CHARS = 20;

function parseRaises(
  value: unknown,
  budgets: PromptBudgetsConfig["budgets"],
  limits: PromptLimit[],
): PromptBudgetRaise[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new PromptBudgetConfigError("`raises` must be an array.");
  return value.map((entry, index) => {
    const at = `raises[${index}]`;
    const raw = requireRecord(entry, at);
    const key = requireString(raw.budget, `${at}.budget`);
    const [persona, harness, limitId] = key.split(".");
    const known =
      AGENT_TYPE_LIST.includes(persona as AgentType) &&
      INVENTORY_HARNESSES.includes(harness as InventoryHarness) &&
      limits.some((limit) => limit.id === limitId) &&
      budgets[persona as AgentType] !== undefined;
    if (!known)
      throw new PromptBudgetConfigError(
        `${at}.budget "${key}" does not name a declared budget (<persona>.<harness>.<limit>).`,
      );
    const why = requireString(raw.why, `${at}.why`);
    if (why.trim().length < MIN_RAISE_REASON_CHARS)
      throw new PromptBudgetConfigError(
        `${at}.why is ${why.trim().length} chars; at least ${MIN_RAISE_REASON_CHARS} are required. Say what the added text buys.`,
      );
    const date = requireString(raw.date, `${at}.date`);
    if (!isCalendarDate(date))
      throw new PromptBudgetConfigError(
        `${at}.date "${date}" is not YYYY-MM-DD.`,
      );
    const from = requireNumber(raw.from, `${at}.from`);
    const to = requireNumber(raw.to, `${at}.to`);
    if (from === to)
      throw new PromptBudgetConfigError(
        `${at} records no change (from === to).`,
      );
    return {
      budget: key,
      from,
      to,
      task: requireString(
        typeof raw.task === "number" ? String(raw.task) : raw.task,
        `${at}.task`,
      ),
      date,
      why,
    };
  });
}

export function loadPromptBudgets(
  path: string = PROMPT_BUDGETS_PATH,
): PromptBudgetsConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new PromptBudgetConfigError(
      `${path} is not readable JSON (${String(err)}).`,
    );
  }
  const raw = requireRecord(parsed, path);
  const measurement = requireRecord(raw.measurement, "`measurement`");
  const limits = parseLimits(raw.limits);
  const budgets = parseBudgets(raw.budgets, limits);
  return {
    path,
    unit: requireString(raw.unit, "`unit`"),
    cwdLabel: requireString(measurement.cwdLabel, "measurement.cwdLabel"),
    snapshotPath: requireString(measurement.snapshot, "measurement.snapshot"),
    warnAtPercentOfBudget: requireNumber(
      raw.warnAtPercentOfBudget,
      "`warnAtPercentOfBudget`",
    ),
    limits,
    budgets,
    raises: parseRaises(raw.raises, budgets, limits),
  };
}

// --- measurement ------------------------------------------------------------

/** Run the inventory exactly the way the budgets are asserted against it. */
export function measureForBudgets(
  config: PromptBudgetsConfig,
): Promise<PromptInventoryReport> {
  return promptInventory({
    promptsDir: REPO_PROMPTS_DIR,
    cwd: REPO_ROOT,
    cwdLabel: config.cwdLabel,
  });
}

function matchesLayerPattern(pattern: string, id: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`).test(id);
}

/** The counted layers one limit sums, in report order. */
export function layersOf(
  limit: PromptLimit,
  persona: PersonaInventory,
): InventoryLayer[] {
  return persona.layers.filter(
    (layer) =>
      layer.counted &&
      limit.sections.includes(layer.section) &&
      (limit.layers === undefined ||
        limit.layers.some((pattern) => matchesLayerPattern(pattern, layer.id))),
  );
}

type BudgetStatus = "ok" | "warn" | "over";

export interface BudgetRow {
  agentType: AgentType;
  harness: InventoryHarness;
  limit: PromptLimit;
  chars: number;
  budget: number;
  percent: number;
  status: BudgetStatus;
  /** The counted layers behind `chars`, largest first. */
  layers: InventoryLayer[];
}

/** The committed ceiling for one persona/harness/limit; never a default. */
function budgetFor(
  config: PromptBudgetsConfig,
  agentType: AgentType,
  harness: InventoryHarness,
  limitId: string,
): number {
  const value = config.budgets[agentType]?.[harness]?.[limitId];
  if (value === undefined)
    throw new PromptBudgetConfigError(
      `no budget declared for ${agentType}.${harness}.${limitId}.`,
    );
  return value;
}

export function budgetRows(
  config: PromptBudgetsConfig,
  report: PromptInventoryReport,
): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const persona of report.personas) {
    for (const limit of config.limits) {
      const layers = layersOf(limit, persona);
      const chars = layers.reduce((n, layer) => n + layer.chars, 0);
      const budget = budgetFor(
        config,
        persona.agentType,
        persona.harness,
        limit.id,
      );
      const percent = budget > 0 ? (chars / budget) * 100 : Infinity;
      rows.push({
        agentType: persona.agentType,
        harness: persona.harness,
        limit,
        chars,
        budget,
        percent,
        status:
          chars > budget
            ? "over"
            : percent >= config.warnAtPercentOfBudget
              ? "warn"
              : "ok",
        layers: [...layers].sort((a, b) => b.chars - a.chars),
      });
    }
  }
  return rows;
}

// --- findings ---------------------------------------------------------------

export interface BudgetFinding {
  level: "error" | "warning";
  message: string;
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Which layers of a breached limit account for the growth, against
 * {@link committedBaseline}. A layer the baseline has never seen is growth from
 * zero — a new conditional section or tool tier is exactly the case worth
 * naming. With no baseline reachable the message falls back to the limit's
 * largest layers and says so, rather than implying an attribution it does not
 * have.
 */
function attribute(row: BudgetRow, baseline: SizeBaseline | undefined): string {
  const grown = (baseline ? row.layers : [])
    .map((layer) => {
      const was = baseline?.layers.get(
        `${row.agentType}/${row.harness}/${layer.id}`,
      );
      return {
        layer,
        delta: layer.chars - (was ?? 0),
        isNew: was === undefined,
      };
    })
    .filter((entry) => entry.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);
  if (grown.length > 0 && baseline)
    return `grew since ${baseline.label}: ${grown
      .map(
        (e) => `${e.layer.id} +${num(e.delta)}${e.isNew ? " (new layer)" : ""}`,
      )
      .join(", ")}`;
  return `largest layers: ${row.layers
    .slice(0, 3)
    .map((layer) => `${layer.id} ${num(layer.chars)}`)
    .join(", ")}`;
}

/**
 * A limit whose selector matches nothing has a budget that can never bind. A
 * typo in `layers` is the likely cause, and the failure it would otherwise
 * produce is silence, so it is reported: an error when the selector is empty
 * everywhere, a warning when it is empty only for some personas (a limit
 * narrowed to a conditional layer legitimately misses the personas without it).
 */
function selectorFindings(
  config: PromptBudgetsConfig,
  rows: BudgetRow[],
): BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  for (const limit of config.limits) {
    const mine = rows.filter((row) => row.limit.id === limit.id);
    const empty = mine.filter((row) => row.layers.length === 0);
    if (empty.length === 0 || mine.length === 0) continue;
    const where = empty
      .map((row) => `${row.agentType}/${row.harness}`)
      .join(", ");
    const selector =
      `sections ${JSON.stringify(limit.sections)}` +
      (limit.layers ? ` + layers ${JSON.stringify(limit.layers)}` : "");
    findings.push(
      empty.length === mine.length
        ? {
            level: "error",
            message:
              `limit "${limit.id}" selects no counted layer for any persona (${selector}) in ` +
              `${relativeConfigPath(config)} — its budget can never bind. Check the selector against the layer ids in ${config.snapshotPath}.`,
          }
        : {
            level: "warning",
            message: `limit "${limit.id}" selects no counted layer for ${where}; its budget cannot bind there.`,
          },
    );
  }
  return findings;
}

/**
 * The raise log must keep up with the numbers it explains. The log is append
 * ordered, so the LAST entry for a budget is the one that has to match it —
 * file order, not `date` order, which nothing sorts.
 */
function staleRaiseFindings(config: PromptBudgetsConfig): BudgetFinding[] {
  const last = new Map<string, PromptBudgetRaise>();
  for (const raise of config.raises) last.set(raise.budget, raise);
  const findings: BudgetFinding[] = [];
  for (const [key, raise] of last) {
    // The key was validated against the declared budgets when it was parsed.
    const [persona = "", harness = "", limitId = ""] = key.split(".");
    const current = budgetFor(
      config,
      persona as AgentType,
      harness as InventoryHarness,
      limitId,
    );
    if (current !== raise.to)
      findings.push({
        level: "error",
        message:
          `stale \`raises\` entry: ${key} is now ${num(current)} but its last entry ` +
          `(${raise.date}, task ${raise.task}) records a change to ${num(raise.to)}. ` +
          "Append an entry for the new value — a lowering counts too.",
      });
  }
  return findings;
}

export function budgetFindings(
  config: PromptBudgetsConfig,
  rows: BudgetRow[],
  baseline?: SizeBaseline,
): BudgetFinding[] {
  const findings: BudgetFinding[] = [];
  for (const row of rows) {
    const where = `${row.agentType}/${row.harness} ${row.limit.label}`;
    if (row.status === "over")
      findings.push({
        level: "error",
        message:
          `${where} is ${num(row.chars)} ${config.unit}, ${num(row.chars - row.budget)} over its ` +
          `${num(row.budget)} budget — ${attribute(row, baseline)}. Trim the layer, or raise ` +
          `\`budgets.${row.agentType}.${row.harness}.${row.limit.id}\` in ${relativeConfigPath(config)} ` +
          "with a `raises` entry saying what the growth buys (docs/prompt-budgets.md).",
      });
    else if (row.status === "warn")
      findings.push({
        level: "warning",
        message: `${where} is ${num(row.chars)} ${config.unit}, ${row.percent.toFixed(0)}% of its ${num(row.budget)} budget.`,
      });
  }
  return [
    ...findings,
    ...selectorFindings(config, rows),
    ...staleRaiseFindings(config),
  ];
}

export function relativeConfigPath(config: PromptBudgetsConfig): string {
  return config.path.startsWith(REPO_ROOT)
    ? config.path.slice(REPO_ROOT.length)
    : config.path;
}

// --- size snapshot ----------------------------------------------------------

const SNAPSHOT_ROW =
  /^\|\s*`([^`]+)`\s*\|\s*(\w+)\s*\|\s*(yes|no)\s*\|\s*([\d,]+)\s*\|$/;

/**
 * The committed snapshot read back as `persona/harness/layer -> chars`. Parsing
 * the rendered table keeps the snapshot a single artifact: one file that both
 * shows the delta in review and gives the budget check its baseline.
 */
export function parseSizeSnapshot(text: string): Map<string, number> {
  const sizes = new Map<string, number>();
  let scope: string | undefined;
  for (const line of text.split("\n")) {
    const heading = /^##\s+(\S+)\s+—\s+(\S+)$/.exec(line.trim());
    if (heading) {
      scope = `${heading[1]}/${heading[2]}`;
      continue;
    }
    const row = SNAPSHOT_ROW.exec(line.trim());
    if (row && scope)
      sizes.set(`${scope}/${row[1]}`, Number((row[4] ?? "").replace(/,/g, "")));
  }
  return sizes;
}

/** Committed layer sizes to attribute growth against, and what they are. */
export interface SizeBaseline {
  /** How the breach message refers to it, e.g. "the sizes at abc1234". */
  label: string;
  layers: Map<string, number>;
}

/**
 * Read-only git through the shared executor: no lock (a reader needs none), no
 * working-tree, index or ref effect. A command that cannot run — no repository,
 * no such ref — yields no output rather than throwing.
 */
async function gitOutput(args: string[]): Promise<string | undefined> {
  const result = await gitOptional(args, REPO_ROOT);
  return result.code === 0 ? result.stdout : undefined;
}

/**
 * The snapshot as last COMMITTED before this change — the only baseline that
 * can name what grew, because the working tree's snapshot is regenerated
 * alongside the very edit that grew it. On a branch that is the merge base with
 * the base ref (so a PR is compared against what it forked from): `PA_BASE_REF`
 * when the caller knows it — CI sets it to the pull request's base, which is
 * not always `main` — else the default branch. With none of them reachable it
 * is `HEAD`, which is still the right answer while iterating on an uncommitted
 * edit. A shallow clone or a snapshot that does not exist yet at that ref
 * yields no baseline, and the breach message then says "largest layers"
 * instead of claiming an attribution.
 */
export async function committedBaseline(
  config: PromptBudgetsConfig,
): Promise<SizeBaseline | undefined> {
  let ref: string | undefined;
  const baseRef = process.env.PA_BASE_REF?.trim();
  for (const branch of [...(baseRef ? [baseRef] : []), "origin/main", "main"]) {
    ref = (await gitOutput(["merge-base", "HEAD", branch]))?.trim();
    if (ref) break;
  }
  ref ||= (await gitOutput(["rev-parse", "HEAD"]))?.trim();
  if (!ref) return undefined;
  const text = await gitOutput(["show", `${ref}:${config.snapshotPath}`]);
  if (text === undefined) return undefined;
  const layers = parseSizeSnapshot(text);
  return layers.size > 0
    ? { label: `the sizes at ${ref.slice(0, 8)}`, layers }
    : undefined;
}

function summaryRows(report: PromptInventoryReport): string[] {
  return report.personas.map(
    (p) =>
      `| ${p.agentType} | ${p.harness} | ${num(p.promptChars)} | ${num(p.eagerToolChars)} | ${num(p.firstRequestChars)} |`,
  );
}

function personaSection(persona: PersonaInventory): string[] {
  return [
    `## ${persona.agentType} — ${persona.harness}`,
    "",
    "| Layer | Section | Counted | Chars |",
    "| --- | --- | --- | ---: |",
    ...persona.layers.map(
      (layer) =>
        `| \`${layer.id}\` | ${layer.section} | ${layer.counted ? "yes" : "no"} | ${num(layer.chars)} |`,
    ),
    "",
  ];
}

/**
 * The committed size snapshot. Sizes only — no budgets, no absolute paths, no
 * prompt text: a budget raise must not churn it, and it must not duplicate the
 * tracked prompt assets whose diff review already sees.
 */
export function renderSizeSnapshot(
  config: PromptBudgetsConfig,
  report: PromptInventoryReport,
): string {
  return [
    "# Assembled prompt sizes",
    "",
    "Generated — never edit by hand. Rewrite it and review the delta with:",
    "",
    "    pnpm --filter @assistant/server test -u src/promptBudgets.test.ts",
    "",
    `All numbers are ${config.unit}, measured against this checkout's`,
    `\`config/prompts\` at the normalized working directory \`${config.cwdLabel}\``,
    "and with every conditional prompt section ON — the worst case over",
    "conditions, at a normalized path. pi's own install directory is",
    `normalized to \`${PI_PACKAGE_LABEL}\` for the same reason, so a CI container`,
    "and a developer checkout measure the same commit alike. The enforced",
    "ceilings live in `config/prompt-budgets.json`; this file records the",
    "sizes only.",
    "",
    "| Persona | Harness | System prompt | Eager tools | First request |",
    "| --- | --- | ---: | ---: | ---: |",
    ...summaryRows(report),
    "",
    ...report.personas.flatMap(personaSection),
  ].join("\n");
}
