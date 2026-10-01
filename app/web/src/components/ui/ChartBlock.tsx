import { useEffect, useRef, useState } from "react";
import type { Chart, ChartConfiguration } from "chart.js";
import {
  chartColor,
  parseChartSpec,
  type ChartSpec,
} from "../../lib/chartSpec.ts";

/**
 * Chart.js needs numeric canvas pixels, so it cannot consume the relative CSS
 * tokens directly (documented Task-184 exception). Instead we READ the computed
 * central sans stack and the resolved `caption`/`body` role sizes off the DOM
 * and hand Chart.js the numbers — never an independent chart scale. Because the
 * roles already fold in `--text-scale`, these values track the text-size
 * preference; the chart is rebuilt when it changes.
 */
interface ChartFonts {
  family: string;
  tickPx: number;
  titlePx: number;
}

function pxOf(probe: HTMLElement, token: string): number {
  probe.style.setProperty("font-size", `var(${token})`);
  const px = Number.parseFloat(getComputedStyle(probe).fontSize);
  return Number.isFinite(px) ? px : 12;
}

function readChartFonts(): ChartFonts {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  try {
    const family =
      getComputedStyle(document.body).fontFamily || "system-ui, sans-serif";
    return {
      family,
      tickPx: pxOf(probe, "--text-caption"),
      titlePx: pxOf(probe, "--text-body"),
    };
  } finally {
    probe.remove();
  }
}

/**
 * Renderer for the Markdown/KB ```chart``` fence (Task 139). Chart.js is
 * lazy-loaded ONLY when a valid spec mounts (kept out of the main bundle); a
 * malformed spec degrades to a plain data block, and an accessible data table
 * is always available (and shown outright if the chart library fails to load),
 * so the feature never depends on canvas/JS to convey the numbers.
 */
export function ChartBlock({ spec: text }: { spec: string }) {
  const parsed = parseChartSpec(text);
  if (!parsed.ok) {
    return (
      <div className="my-2 rounded-lg border border-line bg-raised px-3 py-2 text-caption">
        <p className="mb-1 font-medium text-danger">
          Chart could not be rendered: {parsed.error}
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap text-faint">
          {text.trim()}
        </pre>
      </div>
    );
  }
  return <ChartFigure spec={parsed.spec} />;
}

function toConfiguration(
  spec: ChartSpec,
  fonts: ChartFonts,
): ChartConfiguration {
  const tick = "#94a3b8"; // slate-400: readable on light and dark
  const grid = "rgba(148,163,184,0.2)";
  const tickFont = { family: fonts.family, size: fonts.tickPx };
  const titleFont = { family: fonts.family, size: fonts.titlePx };
  return {
    type: spec.type,
    data: {
      labels: spec.labels,
      datasets: spec.series.map((series, index) => {
        const color = chartColor(index);
        return {
          label: series.label,
          data: series.data,
          backgroundColor: spec.type === "line" ? `${color}33` : color,
          borderColor: color,
          borderWidth: spec.type === "line" ? 2 : 0,
          tension: 0.25,
          fill: spec.type === "line" ? false : undefined,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // Every text element uses the central sans stack and computed role sizes.
      font: { family: fonts.family, size: fonts.tickPx },
      plugins: {
        legend: {
          display: spec.series.length > 1,
          labels: { color: tick, boxWidth: 12, font: tickFont },
        },
        tooltip: { enabled: true, titleFont, bodyFont: tickFont },
      },
      scales: {
        x: {
          stacked: spec.stacked === true,
          ticks: { color: tick, font: tickFont },
          grid: { color: grid },
        },
        y: {
          stacked: spec.stacked === true,
          beginAtZero: true,
          ticks: { color: tick, font: tickFont },
          grid: { color: grid },
          title: spec.yLabel
            ? { display: true, text: spec.yLabel, color: tick, font: titleFont }
            : undefined,
        },
      },
    },
  };
}

function ChartFigure({ spec }: { spec: ChartSpec }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  // Rebuild the canvas when the text-scale preference changes: Chart.js baked
  // the numeric font sizes in at creation, so it cannot reflow them itself.
  const [scaleKey, setScaleKey] = useState(
    () => document.documentElement.getAttribute("data-text-scale") ?? "100",
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setScaleKey(root.getAttribute("data-text-scale") ?? "100");
    });
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-text-scale"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let chart: Chart | null = null;
    let cancelled = false;
    void import("chart.js/auto")
      .then(({ default: ChartJs }) => {
        if (cancelled || !canvasRef.current) return;
        chart = new ChartJs(
          canvasRef.current,
          toConfiguration(spec, readChartFonts()),
        );
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      chart?.destroy();
    };
  }, [spec, scaleKey]);

  return (
    <figure className="my-2 rounded-lg border border-line bg-surface px-3 py-2">
      {spec.title && (
        <figcaption className="mb-1.5 text-caption font-medium text-fg">
          {spec.title}
        </figcaption>
      )}
      {!failed && (
        <div className="relative h-[260px] w-full">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={spec.title ?? "Chart"}
          />
        </div>
      )}
      <details className="mt-1 text-caption text-muted" open={failed}>
        <summary className="cursor-pointer select-none text-faint">
          {failed ? "Chart unavailable — data table" : "Data table"}
        </summary>
        <ChartDataTable spec={spec} />
      </details>
    </figure>
  );
}

function ChartDataTable({ spec }: { spec: ChartSpec }) {
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full border-collapse text-caption">
        <thead>
          <tr>
            <th className="border-b border-line px-2 py-1 text-left font-medium text-muted">
              {" "}
            </th>
            {spec.series.map((series) => (
              <th
                key={series.label}
                className="border-b border-line px-2 py-1 text-right font-medium text-muted"
              >
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.labels.map((label, row) => (
            <tr key={label}>
              <th
                scope="row"
                className="border-b border-line/50 px-2 py-1 text-left font-normal text-fg"
              >
                {label}
              </th>
              {spec.series.map((series) => (
                <td
                  key={series.label}
                  className="border-b border-line/50 px-2 py-1 text-right tabular-nums text-muted"
                >
                  {series.data[row]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
