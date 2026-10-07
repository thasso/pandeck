import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * New fetch-state code must use `useFetchState` + `lib/loadState.ts`.
 *
 * The cancellation census freezes legacy effects owned by later surface
 * migrations. It may shrink, never grow. `useFetchState` itself is the one
 * implementation of keyed cancellation and is therefore outside the census.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_CANCELLED_EFFECTS = new Set([
  "components/common/ChartBlock.tsx",
  "components/common/useHighlighterLanguage.ts",
  "components/worktree/WorktreeChangesetList.tsx",
  "components/worktree/WorktreeDelivery.tsx",
  "hooks/useWorktreeHosting.ts",
]);

function productionSources(): Array<{ path: string; source: string }> {
  const result: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(HERE, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.[tj]sx?$/.test(entry.name)) continue;
    if (/\.test\.[tj]sx?$/.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    const path = relative(HERE, full).split(sep).join("/");
    result.push({ path, source: readFileSync(full, "utf8") });
  }
  return result;
}

describe("fetch-state source audit", () => {
  test("hand-rolled cancelled fetch effects never grow", () => {
    const found = new Set(
      productionSources()
        .filter(
          ({ path, source }) =>
            path !== "hooks/useFetchState.ts" &&
            /\blet\s+cancelled\s*=\s*false\b/.test(source),
        )
        .map(({ path }) => path),
    );
    expect([...found].sort()).toEqual([...LEGACY_CANCELLED_EFFECTS].sort());
  });

  test("bespoke loading-status unions stay in lib/loadState.ts", () => {
    const offenders = productionSources()
      .filter(({ path }) => path !== "lib/loadState.ts")
      .filter(({ source }) =>
        /(?:type|interface)\s+\w+[\s\S]{0,240}status\s*:\s*["'](?:idle|loading|refreshing|ready)["']/.test(
          source,
        ),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
