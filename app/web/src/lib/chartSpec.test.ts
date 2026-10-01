import { describe, expect, it } from "vitest";
import {
  CHART_MAX_POINTS,
  CHART_MAX_SERIES,
  chartColor,
  parseChartSpec,
} from "./chartSpec.ts";

describe("parseChartSpec", () => {
  it("accepts a valid bar spec and keeps only allowed fields", () => {
    const result = parseChartSpec(
      JSON.stringify({
        type: "bar",
        title: "Logged time",
        labels: ["Mon", "Tue"],
        series: [{ label: "Logged", data: [4, 6] }],
        stacked: true,
        extra: "ignored",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.type).toBe("bar");
    expect(result.spec.title).toBe("Logged time");
    expect(result.spec.stacked).toBe(true);
    expect(result.spec.series[0]!.data).toEqual([4, 6]);
    expect("extra" in result.spec).toBe(false);
  });

  it("rejects pie/doughnut and any non bar/line type", () => {
    for (const type of ["pie", "doughnut", "radar", "scatter"]) {
      const result = parseChartSpec(
        JSON.stringify({
          type,
          labels: ["a"],
          series: [{ label: "x", data: [1] }],
        }),
      );
      expect(result.ok).toBe(false);
    }
  });

  it("stacked is ignored for line charts", () => {
    const result = parseChartSpec(
      JSON.stringify({
        type: "line",
        labels: ["a", "b"],
        series: [{ label: "x", data: [1, 2] }],
        stacked: true,
      }),
    );
    expect(result.ok && result.spec.stacked).toBeFalsy();
  });

  it("requires data length to match labels length", () => {
    const result = parseChartSpec(
      JSON.stringify({
        type: "line",
        labels: ["a", "b"],
        series: [{ label: "x", data: [1] }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric data and non-JSON", () => {
    expect(
      parseChartSpec(
        JSON.stringify({
          type: "bar",
          labels: ["a"],
          series: [{ label: "x", data: ["oops"] }],
        }),
      ).ok,
    ).toBe(false);
    expect(parseChartSpec("not json").ok).toBe(false);
  });

  it("enforces item limits", () => {
    const manyLabels = Array.from(
      { length: CHART_MAX_POINTS + 1 },
      (_, i) => `p${i}`,
    );
    const overLabels = parseChartSpec(
      JSON.stringify({
        type: "line",
        labels: manyLabels,
        series: [{ label: "x", data: manyLabels.map(() => 1) }],
      }),
    );
    expect(overLabels.ok).toBe(false);

    const series = Array.from({ length: CHART_MAX_SERIES + 1 }, (_, i) => ({
      label: `s${i}`,
      data: [1],
    }));
    const overSeries = parseChartSpec(
      JSON.stringify({ type: "bar", labels: ["a"], series }),
    );
    expect(overSeries.ok).toBe(false);
  });

  it("colors are deterministic and wrap the palette", () => {
    expect(chartColor(0)).toBe(chartColor(8));
    expect(chartColor(0)).not.toBe(chartColor(1));
  });
});
