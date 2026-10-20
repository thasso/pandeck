/**
 * The pi compaction-window controller on a REAL `SettingsManager` over real
 * `settings.json` files: precedence, model switches, clear, every settings
 * rebuild path of pi 1.1.0, isolation, and the agent rules.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { HARNESSES } from "@assistant/shared";
import {
  PiCompactionWindow,
  DEFAULT_COMPACTION_SETTINGS,
} from "./compactionWindow.ts";

test("shared pre-creation estimate uses pi's actual default reserve", () => {
  const capability = HARNESSES.pi.compactionWindow;
  assert.ok(capability?.mapping === "reserve");
  assert.equal(
    capability.defaultReserve,
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
  );
});

const M = { provider: "p", id: "m", contextWindow: 272_000 };
const N = { provider: "p", id: "n", contextWindow: 200_000 };

let root: string;
let cwd: string;
let agentDir: string;

function writeGlobal(settings: unknown): void {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-compaction-window-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeGlobal({
    compaction: {
      reserveTokens: 20_000,
      modelOverrides: { "p/m": { reserveTokens: 30_000 } },
    },
  });
  // Trusted project: the ordinary reserve is 25 000 there.
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { reserveTokens: 25_000 } }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup(): {
  settings: SettingsManager;
  controller: PiCompactionWindow;
  use: (model: typeof M) => void;
  reserve: (model: typeof M) => number;
} {
  const settings = SettingsManager.create(cwd, agentDir);
  let model = M;
  const controller = new PiCompactionWindow(settings, () => model);
  return {
    settings,
    controller,
    use: (next) => {
      model = next;
      controller.onModelChanged();
    },
    reserve: (target) => settings.getCompactionReserveTokens(target),
  };
}

test("the per-model override beats modelOverrides and follows model switches", () => {
  const { controller, use, reserve } = setup();
  assert.equal(reserve(M), 30_000);
  assert.deepEqual(controller.status(), {
    live: {
      applied: "confirmed",
      appliedTokens: null,
      providerTrigger: 242_000,
    },
    contextWindow: 272_000,
    underlyingReserve: 30_000,
  });

  assert.deepEqual(controller.apply(150_000), {});
  assert.equal(reserve(M), 122_000);
  assert.deepEqual(controller.status(), {
    live: {
      applied: "confirmed",
      appliedTokens: 150_000,
      providerTrigger: 150_000,
    },
    contextWindow: 272_000,
    underlyingReserve: 30_000,
  });

  use(N);
  assert.equal(reserve(N), 200_000 - 150_000);
  assert.equal(reserve(M), 122_000, "the earlier key keeps its override");

  controller.apply(null);
  assert.equal(reserve(N), 25_000);
  assert.equal(reserve(M), 30_000);
});

test("a window above the native trigger is clamped to it", () => {
  const { controller, reserve } = setup();
  controller.apply(500_000);
  assert.equal(reserve(M), 30_000);
  assert.equal(controller.status().live.appliedTokens, 242_000);
});

test("reload with changed settings: the new underlying value is the baseline", async () => {
  const { settings, controller, reserve } = setup();
  controller.apply(150_000);
  writeGlobal({
    compaction: {
      reserveTokens: 20_000,
      modelOverrides: {
        "p/m": { reserveTokens: 122_000 },
        "p/n": { reserveTokens: 10_000 },
      },
    },
  });
  await settings.reload();
  assert.equal(reserve(M), 122_000, "re-applied after the rebuild");
  controller.apply(null);
  assert.equal(reserve(M), 122_000, "clear restores the CURRENT underlying");
});

test("a non-current key uses its re-read underlying value after reload", async () => {
  const { settings, controller, use, reserve } = setup();
  controller.apply(150_000);
  writeGlobal({
    compaction: {
      reserveTokens: 20_000,
      modelOverrides: {
        "p/m": { reserveTokens: 30_000 },
        "p/n": { reserveTokens: 10_000 },
      },
    },
  });
  await settings.reload();
  use(N);
  assert.equal(reserve(N), 50_000);
  assert.equal(controller.status().underlyingReserve, 10_000);
  controller.apply(null);
  assert.equal(reserve(N), 10_000);
});

test("unchanged trust never rebuilds, so overrides are never taken for baselines", () => {
  const { settings, controller, use, reserve } = setup();
  controller.apply(150_000);
  use(N);
  use(M);
  settings.setProjectTrusted(settings.isProjectTrusted());
  settings.setProjectTrusted(settings.isProjectTrusted());
  assert.equal(reserve(M), 122_000);
  controller.apply(null);
  assert.equal(reserve(M), 30_000);
  assert.equal(reserve(N), 25_000);
});

test("changed trust rebuilds; the override returns over the new underlying value", () => {
  const { settings, controller, use, reserve } = setup();
  controller.apply(150_000);
  settings.setProjectTrusted(false);
  assert.equal(reserve(M), 122_000);
  use(N);
  assert.equal(reserve(N), 50_000);
  controller.apply(null);
  assert.equal(reserve(N), 20_000, "the untrusted project's reserve is gone");
});

test("a setter that saves rebuilds settings; the override survives it", () => {
  const { settings, controller, reserve } = setup();
  controller.apply(150_000);
  settings.setDefaultThinkingLevel("low");
  assert.equal(reserve(M), 122_000);
  controller.apply(null);
  assert.equal(reserve(M), 30_000);
});

test("a project write that throws before rebuilding leaves everything alone", () => {
  const { settings, controller, reserve } = setup();
  settings.setProjectTrusted(false);
  controller.apply(150_000);
  assert.throws(() =>
    (
      settings as unknown as { saveProjectSettings(value: unknown): void }
    ).saveProjectSettings({}),
  );
  assert.equal(reserve(M), 122_000);
  controller.apply(null);
  assert.equal(reserve(M), 30_000);
});

test("disabled compaction applies nothing; a second manager never sees an override", () => {
  writeGlobal({ compaction: { enabled: false, reserveTokens: 20_000 } });
  const { controller, reserve } = setup();
  assert.deepEqual(controller.apply(150_000), { disabled: true });
  assert.equal(reserve(M), 25_000, "the project's own reserve, untouched");
  assert.deepEqual(controller.status().live, {
    applied: "pending",
    disabled: true,
  });
  assert.equal(controller.lower(120_000, () => {}).ok, false);

  writeGlobal({ compaction: { reserveTokens: 20_000 } });
  const first = setup();
  const second = SettingsManager.create(cwd, agentDir);
  first.controller.apply(150_000);
  assert.equal(first.reserve(M), 122_000);
  assert.equal(second.getCompactionReserveTokens(M), 25_000);
});

test("agent: lowers only below the current trigger, never under 100k", () => {
  const { controller, reserve } = setup();
  controller.apply(150_000);
  const stored: number[] = [];
  const persist = (tokens: number) => void stored.push(tokens);

  const raise = controller.lower(160_000, persist);
  assert.equal(raise.ok, false);
  assert.equal(!raise.ok && raise.largestAcceptable, 149_999);
  assert.equal(controller.lower(90_000, persist).ok, false);
  assert.deepEqual(stored, []);
  assert.equal(reserve(M), 122_000, "refusals change nothing");

  assert.deepEqual(controller.lower(120_000, persist), {
    ok: true,
    previous: 150_000,
    applied: 120_000,
  });
  assert.deepEqual(stored, [120_000]);
  assert.equal(reserve(M), 152_000);

  controller.apply(90_000);
  const floor = controller.lower(100_000, persist);
  assert.equal(floor.ok, false);
  assert.match(!floor.ok ? floor.message : "", /cannot lower it further/);
});

test("agent: precedence of disabled, unknown and the floor", () => {
  const { settings, controller } = setup();
  const original = settings.applyOverrides.bind(settings);
  settings.applyOverrides = () => {
    throw new Error("override refused");
  };
  assert.match(controller.apply(150_000).applyError ?? "", /override refused/);
  assert.equal(controller.status().live.applied, "unknown");
  settings.applyOverrides = original;

  const unknownFloor = controller.lower(90_000, () => {});
  assert.match(!unknownFloor.ok ? unknownFloor.message : "", /unknown/);

  writeGlobal({ compaction: { enabled: false } });
  const disabled = setup();
  const disabledOriginal = disabled.settings.applyOverrides.bind(
    disabled.settings,
  );
  disabled.settings.applyOverrides = () => {
    throw new Error("override refused");
  };
  disabled.controller.apply(150_000);
  disabled.settings.applyOverrides = disabledOriginal;
  const both = disabled.controller.lower(90_000, () => {});
  assert.match(!both.ok ? both.message : "", /turned off/);
});

test("agent: a failed persist restores the previous window, never the row", () => {
  const { controller, reserve } = setup();
  controller.apply(150_000);
  const result = controller.lower(120_000, () => {
    throw new Error("disk full");
  });
  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.message : "", /disk full/);
  assert.equal(reserve(M), 122_000);
  assert.equal(controller.status().live.appliedTokens, 150_000);

  controller.apply(null);
  const fromDefault = controller.lower(200_000, () => {
    throw new Error("disk full");
  });
  assert.equal(fromDefault.ok, false);
  assert.equal(
    reserve(M),
    30_000,
    "a cleared window goes back to pi's reserve",
  );
});
