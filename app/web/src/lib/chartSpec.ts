/**
 * Constrained chart-spec schema for the Markdown/KB ```chart``` fence (Task 139).
 * Pure + framework-free so it is unit-testable and shared by the renderer and its
 * accessible table fallback. Deliberately NARROW: only `bar` and `line` (NO pie/
 * doughnut, per the plan — no contributor rankings), with hard item limits and
 * strict shape validation so a malformed or oversized spec degrades gracefully
 * instead of throwing. Numbers only; labels/series are bounded.
 */

export const CHART_MAX_POINTS = 60;
export const CHART_MAX_SERIES = 8;
const TITLE_MAX = 120;
const LABEL_MAX = 60;

type ChartKind = "bar" | "line";

interface ChartSeries {
  label: string;
  data: number[];
}

export interface ChartSpec {
  type: ChartKind;
  title?: string;
  /** X-axis category labels; one value per point. */
  labels: string[];
  series: ChartSeries[];
  /** Bar charts only: stack series into one bar. */
  stacked?: boolean;
  /** Optional y-axis label. */
  yLabel?: string;
}

export type ChartParseResult =
  { ok: true; spec: ChartSpec } | { ok: false; error: string };

/** Deterministic, theme-agnostic palette indexed by series order (no random colors). */
const CHART_PALETTE = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#14b8a6", // teal
  "#ec4899", // pink
  "#64748b", // slate
] as const;

export function chartColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]!;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * Parse + validate a ```chart``` fence body. Returns a typed spec or a concrete
 * error string; never throws. The caller renders the error as a plain data block.
 */
export function parseChartSpec(text: string): ChartParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Chart spec is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Chart spec must be a JSON object." };
  }
  const obj = raw as Record<string, unknown>;

  const type = obj.type;
  if (type !== "bar" && type !== "line") {
    return {
      ok: false,
      error: `Unsupported chart type "${String(type)}" — only "bar" and "line" are allowed.`,
    };
  }

  if (!Array.isArray(obj.labels) || obj.labels.length === 0) {
    return { ok: false, error: 'Chart spec needs a non-empty "labels" array.' };
  }
  if (obj.labels.length > CHART_MAX_POINTS) {
    return {
      ok: false,
      error: `Too many labels (${obj.labels.length}); the limit is ${CHART_MAX_POINTS}.`,
    };
  }
  const labels: string[] = [];
  for (const label of obj.labels) {
    if (typeof label !== "string")
      return { ok: false, error: 'Every entry in "labels" must be a string.' };
    labels.push(label.slice(0, LABEL_MAX));
  }

  if (!Array.isArray(obj.series) || obj.series.length === 0) {
    return { ok: false, error: 'Chart spec needs a non-empty "series" array.' };
  }
  if (obj.series.length > CHART_MAX_SERIES) {
    return {
      ok: false,
      error: `Too many series (${obj.series.length}); the limit is ${CHART_MAX_SERIES}.`,
    };
  }
  const series: ChartSeries[] = [];
  for (const [index, entry] of obj.series.entries()) {
    if (typeof entry !== "object" || entry === null)
      return { ok: false, error: `Series ${index + 1} must be an object.` };
    const seriesObj = entry as Record<string, unknown>;
    const label =
      boundedString(seriesObj.label, LABEL_MAX) ?? `Series ${index + 1}`;
    if (!Array.isArray(seriesObj.data))
      return { ok: false, error: `Series "${label}" needs a "data" array.` };
    if (seriesObj.data.length !== labels.length) {
      return {
        ok: false,
        error: `Series "${label}" has ${seriesObj.data.length} points but there are ${labels.length} labels.`,
      };
    }
    const data: number[] = [];
    for (const point of seriesObj.data) {
      if (!isFiniteNumber(point))
        return {
          ok: false,
          error: `Series "${label}" contains a non-numeric value.`,
        };
      data.push(point);
    }
    series.push({ label, data });
  }

  const spec: ChartSpec = { type, labels, series };
  const title = boundedString(obj.title, TITLE_MAX);
  if (title) spec.title = title;
  const yLabel = boundedString(obj.yLabel, LABEL_MAX);
  if (yLabel) spec.yLabel = yLabel;
  if (type === "bar" && obj.stacked === true) spec.stacked = true;
  return { ok: true, spec };
}
