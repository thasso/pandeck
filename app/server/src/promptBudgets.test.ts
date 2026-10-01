/**
 * Task 288: the prompt budgets and the size snapshot, asserted in `pnpm run
 * test` and CI.
 *
 *   pnpm --filter @assistant/server test src/promptBudgets.test.ts
 *   pnpm --filter @assistant/server test -u src/promptBudgets.test.ts   # snapshot
 *
 * The snapshot covers all four personas on both harnesses, layer by layer, so a
 * prompt or tool edit lands in review as a size delta. When it changes, read the
 * delta and decide: it is normal for a prompt to grow when the text earns its
 * characters. A breached budget is the same decision made explicitly — trim, or
 * raise the number in `config/prompt-budgets.json` with a `raises` entry.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  budgetFindings,
  budgetRows,
  committedBaseline,
  layersOf,
  loadPromptBudgets,
  measureForBudgets,
  parseSizeSnapshot,
  PromptBudgetConfigError,
  PROMPT_BUDGETS_PATH,
  renderSizeSnapshot,
  type PromptBudgetsConfig,
} from "./promptBudgets.ts";
import { AGENT_TYPES, type AgentType } from "./agentTypes.ts";
import {
  INVENTORY_HARNESSES,
  REPO_ROOT,
  type PromptInventoryReport,
} from "./promptInventory.ts";

const SNAPSHOT_FILE = "./__snapshots__/prompt-sizes.md";

/** The committed config with one edit, written where the loader can read it. */
function configWith(
  edit: (raw: Record<string, unknown>) => void,
): () => PromptBudgetsConfig {
  const raw = JSON.parse(readFileSync(PROMPT_BUDGETS_PATH, "utf8"));
  edit(raw);
  const path = join(
    mkdtempSync(join(tmpdir(), "prompt-budgets-")),
    "prompt-budgets.json",
  );
  writeFileSync(path, JSON.stringify(raw, null, 2));
  return () => loadPromptBudgets(path);
}

/**
 * The live value of one budget, so a fixture that must MATCH the config does not
 * have to be edited every time the number legitimately moves.
 */
function currentBudget(
  persona: string,
  harness: string,
  limit: string,
): number {
  const raw = JSON.parse(readFileSync(PROMPT_BUDGETS_PATH, "utf8"));
  return raw.budgets[persona][harness][limit] as number;
}

/** One valid `raises` entry for the budget it names. */
function raise(budget: string, to: number): Record<string, unknown> {
  return {
    budget,
    from: to - 500,
    to,
    task: 288,
    date: "2026-08-03",
    why: "the tool schemas grew with a field the model needs",
  };
}

let cached: Promise<{
  config: PromptBudgetsConfig;
  report: PromptInventoryReport;
}> | null = null;

/** One measurement for the whole file: the inventory assembles 8 prompts. */
function measured() {
  cached ??= (async () => {
    const config = loadPromptBudgets();
    return { config, report: await measureForBudgets(config) };
  })();
  return cached;
}

describe("prompt budgets", () => {
  test("the committed config covers every persona, harness and limit", async () => {
    const { config } = await measured();
    for (const agentType of Object.keys(AGENT_TYPES) as AgentType[])
      for (const harness of INVENTORY_HARNESSES)
        for (const limit of config.limits)
          assert.ok(
            typeof config.budgets[agentType][harness][limit.id] === "number",
            `no budget for ${agentType}/${harness}/${limit.id}`,
          );
    assert.deepEqual(
      config.limits.map((limit) => limit.id).sort(),
      ["eagerTools", "firstRequest", "prompt"],
      "the budgeted limits changed — the docs and the snapshot header describe these",
    );
  });

  test("a malformed config fails loudly instead of defaulting", () => {
    assert.throws(
      () => loadPromptBudgets("/definitely/missing/prompt-budgets.json"),
      PromptBudgetConfigError,
    );
  });

  test("limits sum the layers the inventory reports, not a parallel count", async () => {
    const { config, report } = await measured();
    const byId = new Map(config.limits.map((limit) => [limit.id, limit]));
    for (const persona of report.personas) {
      assert.equal(
        layersOf(byId.get("prompt")!, persona).reduce((n, l) => n + l.chars, 0),
        persona.promptChars,
      );
      assert.equal(
        layersOf(byId.get("eagerTools")!, persona).reduce(
          (n, l) => n + l.chars,
          0,
        ),
        persona.eagerToolChars,
      );
      assert.equal(
        layersOf(byId.get("firstRequest")!, persona).reduce(
          (n, l) => n + l.chars,
          0,
        ),
        persona.firstRequestChars,
      );
    }
  });

  test("every persona and harness is within its budget", async () => {
    const { config, report } = await measured();
    const rows = budgetRows(config, report);
    assert.equal(
      rows.length,
      report.personas.length * config.limits.length,
      "every persona/harness must be held against every limit",
    );
    // The same baseline the CLI uses, so a breach here reads the same way.
    const findings = budgetFindings(
      config,
      rows,
      await committedBaseline(config),
    );
    const errors = findings.filter((finding) => finding.level === "error");
    assert.deepEqual(
      errors.map((finding) => finding.message),
      [],
      "prompt budget breached — trim the named layer, or raise the budget in config/prompt-budgets.json with a `raises` entry (docs/prompt-budgets.md)",
    );
  });

  test("a breach names the layer that grew against the committed sizes", async () => {
    const { config, report } = await measured();
    const rows = budgetRows(config, report);
    const row = rows.find((candidate) => candidate.limit.id === "eagerTools")!;
    const [grown, alsoGrown] = [row.layers[0]!, row.layers[1]!];
    // A baseline holding one layer smaller and not holding the other at all:
    // the second is a layer this change introduced, which is growth from zero.
    const baseline = {
      label: "the sizes at deadbeef",
      layers: new Map(
        row.layers
          .filter((layer) => layer.id !== alsoGrown.id)
          .map((layer) => [
            `${row.agentType}/${row.harness}/${layer.id}`,
            layer.id === grown.id ? layer.chars - 500 : layer.chars,
          ]),
      ),
    };
    const finding = budgetFindings(
      config,
      [{ ...row, budget: row.chars - 1, status: "over", percent: 101 }],
      baseline,
    )[0]!;
    assert.equal(finding.level, "error");
    assert.match(finding.message, /grew since the sizes at deadbeef/);
    assert.match(finding.message, new RegExp(`${grown.id} \\+500`));
    assert.match(
      finding.message,
      new RegExp(`${alsoGrown.id} \\+[\\d,]+ \\(new layer\\)`),
      "a layer the baseline has never seen is growth from zero",
    );
    assert.match(finding.message, /config\/prompt-budgets\.json/);
  });

  test("without a baseline the message claims no attribution", async () => {
    const { config, report } = await measured();
    const row = budgetRows(config, report).find(
      (candidate) => candidate.limit.id === "prompt",
    )!;
    const finding = budgetFindings(
      config,
      [{ ...row, budget: row.chars - 1, status: "over", percent: 101 }],
      undefined,
    )[0]!;
    assert.match(finding.message, /largest layers: /);
    assert.doesNotMatch(finding.message, /grew since/);
  });

  test("the committed baseline is read from git, not from the working tree", async () => {
    const { config } = await measured();
    const baseline = await committedBaseline(config);
    // Undefined only before the snapshot's first commit or in a shallow clone;
    // when there is one it must be layer sizes, not an empty map.
    if (baseline) {
      assert.match(baseline.label, /^the sizes at [0-9a-f]{8}$/);
      assert.ok(baseline.layers.size > 0);
    }
    // A committed file that is not a snapshot yields no baseline rather than an
    // empty one: this exercises the `git show` itself, whatever the branch.
    assert.equal(
      await committedBaseline({ ...config, snapshotPath: "CLAUDE.md" }),
      undefined,
    );
  });

  test("the baseline follows the base ref CI names, not main", async () => {
    const { config } = await measured();
    // A PR against an intermediate base branch has to be attributed against
    // THAT branch; `PA_BASE_REF` is how CI says which one. `HEAD` stands in for
    // it here: its merge base with HEAD is HEAD itself, so the label names a
    // commit the main-only lookup would not have picked on a branch.
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const previous = process.env.PA_BASE_REF;
    process.env.PA_BASE_REF = "HEAD";
    let baseline;
    try {
      baseline = await committedBaseline(config);
    } finally {
      if (previous === undefined) delete process.env.PA_BASE_REF;
      else process.env.PA_BASE_REF = previous;
    }
    assert.ok(baseline, "the snapshot is committed at HEAD");
    assert.equal(baseline.label, `the sizes at ${head.slice(0, 8)}`);
  });

  test("a limit whose selector matches nothing fails instead of passing", async () => {
    const load = configWith((raw) => {
      const limits = raw.limits as Array<Record<string, unknown>>;
      limits.push({
        id: "typo",
        label: "typo'd selector",
        sections: ["tools"],
        layers: ["tools:eager:schema"], // the layer is `schemas`
      });
      for (const perHarness of Object.values(
        raw.budgets as Record<string, Record<string, Record<string, number>>>,
      ))
        for (const perLimit of Object.values(perHarness)) perLimit.typo = 1000;
    });
    const config = load();
    const { report } = await measured();
    const findings = budgetFindings(config, budgetRows(config, report));
    const error = findings.find((finding) => finding.level === "error");
    assert.ok(error, "a selector matching nothing must not report a green 0");
    assert.match(error.message, /limit "typo" selects no counted layer/);
  });

  test("a limit narrowed to a conditional layer warns where it cannot bind", async () => {
    const load = configWith((raw) => {
      const limits = raw.limits as Array<Record<string, unknown>>;
      limits.push({
        id: "slackOnly",
        label: "slack section",
        sections: ["prompt"],
        layers: ["integration:slack"],
      });
      for (const perHarness of Object.values(
        raw.budgets as Record<string, Record<string, Record<string, number>>>,
      ))
        for (const perLimit of Object.values(perHarness))
          perLimit.slackOnly = 2000;
    });
    const config = load();
    const { report } = await measured();
    const findings = budgetFindings(config, budgetRows(config, report));
    assert.deepEqual(
      findings.filter((finding) => finding.level === "error"),
      [],
      "a layer only some personas carry is not a broken selector",
    );
    assert.ok(
      findings.some(
        (finding) =>
          finding.level === "warning" &&
          finding.message.includes(
            'limit "slackOnly" selects no counted layer',
          ),
      ),
    );
  });

  describe("the raises log", () => {
    test("an entry matching its budget is accepted", async () => {
      const { report } = await measured();
      const config = configWith((raw) => {
        raw.raises = [
          raise(
            "workshop.pi.eagerTools",
            currentBudget("workshop", "pi", "eagerTools"),
          ),
        ];
      })();
      assert.equal(config.raises.length, 1);
      assert.deepEqual(
        budgetFindings(config, budgetRows(config, report)).filter(
          (finding) => finding.level === "error",
        ),
        [],
      );
    });

    test("an entry that no longer matches its budget is stale", async () => {
      const { report } = await measured();
      const config = configWith((raw) => {
        raw.raises = [raise("workshop.pi.eagerTools", 19500)];
      })();
      const error = budgetFindings(config, budgetRows(config, report)).find(
        (finding) => finding.level === "error",
      );
      assert.ok(error, "the log must not silently outlive the number");
      assert.match(
        error.message,
        /stale `raises` entry: workshop.pi.eagerTools/,
      );
      assert.match(error.message, /its last entry/);
    });

    test("the last entry for a budget is the one that must match", async () => {
      const { report } = await measured();
      const config = configWith((raw) => {
        const current = currentBudget("workshop", "pi", "eagerTools");
        raw.raises = [
          raise("workshop.pi.eagerTools", current - 500),
          raise("workshop.pi.eagerTools", current),
        ];
      })();
      assert.deepEqual(
        budgetFindings(config, budgetRows(config, report)).filter(
          (finding) => finding.level === "error",
        ),
        [],
      );
    });

    for (const [name, edit] of [
      [
        "a budget key that names nothing",
        (raw: Record<string, unknown>) => {
          raw.raises = [
            {
              ...raise("workshop.pi.eagerTools", 18500),
              budget: "workshop.pi.tools",
            },
          ];
        },
      ],
      [
        "a stub reason",
        (raw: Record<string, unknown>) => {
          raw.raises = [
            { ...raise("workshop.pi.eagerTools", 18500), why: "too big" },
          ];
        },
      ],
      [
        "a date that is not YYYY-MM-DD",
        (raw: Record<string, unknown>) => {
          raw.raises = [
            { ...raise("workshop.pi.eagerTools", 18500), date: "2026-13-40" },
          ];
        },
      ],
      [
        "an entry recording no change",
        (raw: Record<string, unknown>) => {
          raw.raises = [
            { ...raise("workshop.pi.eagerTools", 18500), from: 18500 },
          ];
        },
      ],
      [
        "a missing task",
        (raw: Record<string, unknown>) => {
          const { task: _task, ...rest } = raise(
            "workshop.pi.eagerTools",
            18500,
          );
          raw.raises = [rest];
        },
      ],
    ] as const)
      test(`rejects ${name}`, () => {
        assert.throws(configWith(edit), PromptBudgetConfigError);
      });
  });

  describe("the budget table", () => {
    for (const [name, edit] of [
      [
        "an unknown persona",
        (raw: Record<string, unknown>) => {
          (raw.budgets as Record<string, unknown>).assistent = {};
        },
      ],
      [
        "an unknown harness",
        (raw: Record<string, unknown>) => {
          (
            raw.budgets as Record<string, Record<string, unknown>>
          ).assistant!.gpt = {};
        },
      ],
      [
        "a limit with no number",
        (raw: Record<string, unknown>) => {
          delete (
            raw.budgets as Record<
              string,
              Record<string, Record<string, number>>
            >
          ).assistant!.pi!.eagerTools;
        },
      ],
      [
        "a limit selecting an unknown section",
        (raw: Record<string, unknown>) => {
          (raw.limits as Array<Record<string, unknown>>)[0]!.sections = [
            "prompts",
          ];
        },
      ],
    ] as const)
      test(`rejects ${name}`, () => {
        assert.throws(configWith(edit), PromptBudgetConfigError);
      });
  });

  test("assembled prompt sizes per persona and harness", async () => {
    const { config, report } = await measured();
    assert.equal(
      join("app/server/src", SNAPSHOT_FILE.replace("./", "")),
      config.snapshotPath,
      "this test writes a different file than measurement.snapshot names",
    );
    const rendered = renderSizeSnapshot(config, report);
    // The snapshot doubles as the breach baseline, so it must parse back.
    const parsed = parseSizeSnapshot(rendered);
    for (const persona of report.personas)
      for (const layer of persona.layers)
        assert.equal(
          parsed.get(`${persona.agentType}/${persona.harness}/${layer.id}`),
          layer.chars,
          `${persona.agentType}/${persona.harness}: layer ${layer.id} does not round-trip`,
        );
    await expect(rendered).toMatchFileSnapshot(SNAPSHOT_FILE);
  });
});
