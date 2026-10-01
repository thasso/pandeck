import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyMachineRegion,
  DATA_REGION_END,
  DATA_REGION_START,
  renderMachineAppendix,
  skeletonEntry,
} from "./appendix.ts";
import { buildRollup } from "./salience.ts";
import type { DayRunManifest } from "./types.ts";

const manifest: DayRunManifest = {
  schemaVersion: 1,
  runId: "2026-07-13-abc",
  date: "2026-07-13",
  window: {
    startIso: "2026-07-12T22:00:00.000Z",
    endIso: "2026-07-13T22:00:00.000Z",
    timeZone: "Europe/Berlin",
  },
  asOf: "2026-07-13T18:00:00.000Z",
  mappingVersion: "m1",
  sources: [
    {
      key: "jira",
      label: "Jira",
      disposition: "attempted",
      result: "complete",
      factCount: 3,
      added: 2,
      changed: 1,
    },
    {
      key: "tempo",
      label: "Tempo",
      disposition: "skipped",
      skipReason: "unconfigured",
    },
  ],
  changesSinceLastRun: 3,
};

const rollup = buildRollup({
  runId: "2026-07-13-abc",
  date: "2026-07-13",
  schemaVersion: 1,
  mappingVersion: "m1",
  classified: [],
});

test("skeleton entry has valid frontmatter shape, the machine region, and a user-owned Notes section", () => {
  const appendix = renderMachineAppendix(manifest, rollup, []);
  assert.ok(
    !appendix.includes("| --- |"),
    "no wide markdown tables — the appendix is list-based for mobile readability",
  );
  assert.match(
    appendix,
    /- \*\*Jira\*\* — complete · 3 facts · \+2\/~1/,
    "source health renders as a compact list line",
  );
  const doc = skeletonEntry("2026-07-13", appendix);
  assert.match(
    doc,
    /kb:\n {2}schema: 1\n {2}id: daily-summary-2026-07-13\n {2}type: daily-summary/,
  );
  assert.ok(doc.includes(DATA_REGION_START) && doc.includes(DATA_REGION_END));
  assert.ok(doc.includes("## Notes"));
  assert.ok(
    doc.indexOf("## Notes") > doc.indexOf(DATA_REGION_END),
    "Notes stays below the data region",
  );
  assert.match(
    doc,
    /skipped \(unconfigured\)/,
    "skipped is rendered as skipped, never failed",
  );
});

test("applyMachineRegion rewrites ONLY the marked region and preserves user content", () => {
  const appendix1 = renderMachineAppendix(manifest, rollup, []);
  const original = skeletonEntry("2026-07-13", appendix1);
  // Simulate a user edit outside the region and a note inside Notes.
  const userEdited = original
    .replace(
      "<!-- Narrative sections are written by the day synthesis run. -->",
      "## Headline\n\n- my own bullet",
    )
    .replace(
      "<!-- User-owned notes. The day scanner and synthesis never touch this section. -->",
      "Remember to call Christian.",
    );
  const appendix2 = renderMachineAppendix(
    { ...manifest, runId: "2026-07-13-def", asOf: "2026-07-13T20:00:00.000Z" },
    rollup,
    [],
  );
  const updated = applyMachineRegion(userEdited, appendix2);
  assert.ok(updated.includes("- my own bullet"), "narrative preserved");
  assert.ok(updated.includes("Remember to call Christian."), "Notes preserved");
  assert.ok(updated.includes("2026-07-13-def"), "region refreshed");
  assert.ok(!updated.includes("2026-07-13-abc"), "old region content replaced");
  assert.equal(
    updated.split(DATA_REGION_START).length,
    2,
    "exactly one region",
  );
});

test("a document without markers gets the region inserted before Notes", () => {
  const doc =
    "# Daily summary 2026-07-13\n\nSome narrative.\n\n## Notes\n\nmy note\n";
  const updated = applyMachineRegion(
    doc,
    `${DATA_REGION_START}\nDATA\n${DATA_REGION_END}`,
  );
  assert.ok(updated.indexOf("DATA") < updated.indexOf("## Notes"));
  assert.ok(updated.includes("my note"));
});
