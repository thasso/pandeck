/**
 * `pnpm run measure:prompts` — emit the Task-281 prompt and schema inventory.
 *
 * Prints the per-persona, per-layer table for both harnesses, twice: once
 * against the prompt directory this process resolves ({@link PROMPTS_DIR} — the
 * packaged assets, or an `ASSISTANT_PROMPTS_DIR` override) and once against this
 * checkout's tracked `config/prompts`. The two runs are collapsed into one when
 * they resolve the same directory, which is the normal case for a checkout since
 * Task-291.
 *
 *   pnpm run measure:prompts              # markdown tables
 *   pnpm run measure:prompts -- --json    # the raw report objects
 *   pnpm run measure:prompts -- --cwd /some/repo
 *
 * All numbers are CHARACTERS — see the rationale in `promptInventory.ts`.
 */
import {
  promptInventory,
  REPO_PROMPTS_DIR,
  REPO_ROOT,
  type PersonaInventory,
  type PromptInventoryReport,
} from "./promptInventory.ts";

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1];
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline?.slice(flag.length + 1);
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function personaTable(persona: PersonaInventory): string {
  const rows = persona.layers.map((layer) => {
    const chars = layer.counted ? num(layer.chars) : `(${num(layer.chars)})`;
    const note = [layer.note].filter(Boolean).join(" ");
    return `| \`${layer.id}\` | ${chars} | ${layer.source} | ${note} |`;
  });
  return [
    `### ${persona.agentType} — ${persona.harness}`,
    "",
    `system prompt **${num(persona.promptChars)}** + eager tool block **${num(
      persona.eagerToolChars,
    )}** = first request **${num(persona.firstRequestChars)}** chars` +
      (persona.reconciled
        ? ""
        : `  \n⚠️ counted rows (${num(persona.promptChars)}) do not reconcile with the assembled prompt (${num(
            persona.assembledPromptChars,
          )})`),
    "",
    "| Layer | Chars | Source | Notes |",
    "| --- | ---: | --- | --- |",
    ...rows,
    "",
    "Parenthesised rows are reported but NOT counted in the totals.",
  ].join("\n");
}

function summaryTable(report: PromptInventoryReport): string {
  const rows = report.personas.map(
    (p) =>
      `| ${p.agentType} | ${p.harness} | ${num(p.promptChars)} | ${num(
        p.eagerToolChars,
      )} | ${num(p.firstRequestChars)} |`,
  );
  return [
    "| Persona | Harness | System prompt | Eager tools | First request |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}

/**
 * What each session-start condition costs the sessions that carry it — the
 * saving a session without it takes off the totals above (Task 287).
 */
function conditionSavingsTable(report: PromptInventoryReport): string {
  if (report.conditionSavings.length === 0)
    return "_No conditional sections are configured._";
  const rows = report.conditionSavings.map(
    (s) =>
      `| ${s.agentType} | ${s.harness} | \`${s.condition}\` | ${num(
        s.promptChars,
      )} | ${num(s.toolChars)} | ${num(s.chars)} |`,
  );
  return [
    "| Persona | Harness | Condition | Prompt | Eager tools | Saved when off |",
    "| --- | --- | --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}

function renderReport(title: string, report: PromptInventoryReport): string {
  return [
    `## ${title}`,
    "",
    `- prompts dir: \`${report.promptsDir}\``,
    `- cwd: \`${report.cwd}\``,
    `- pi prompt module: \`${report.piPromptModulePath}\``,
    `- project context counted: ${
      report.countedContextFiles.map((f) => `\`${f}\``).join(", ") || "none"
    }`,
    ...(report.excludedContextFiles.length > 0
      ? [
          `- project context available but NOT counted (outside cwd): ${report.excludedContextFiles
            .map((f) => `\`${f}\``)
            .join(", ")}`,
        ]
      : []),
    "",
    summaryTable(report),
    "",
    "### Session-start conditions — saving per persona and condition",
    "",
    "Every table above is measured with all conditional sections ON; a session",
    "without a condition saves the characters in its row.",
    "",
    conditionSavingsTable(report),
    "",
    ...report.personas.flatMap((p) => [personaTable(p), ""]),
  ].join("\n");
}

async function main(): Promise<void> {
  const cwd = arg("cwd") ?? REPO_ROOT;
  const asShipped = await promptInventory({ cwd });
  const asTracked =
    asShipped.promptsDir === REPO_PROMPTS_DIR
      ? undefined
      : await promptInventory({ cwd, promptsDir: REPO_PROMPTS_DIR });

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        asTracked ? { asShipped, asTracked } : { asShipped },
        null,
        2,
      ),
    );
    return;
  }

  console.log("# Prompt and schema inventory (characters)\n");
  console.log(
    renderReport(
      asTracked
        ? "As this process resolves prompts (ASSISTANT_PROMPTS_DIR)"
        : "Resolved prompts",
      asShipped,
    ),
  );
  if (asTracked)
    console.log(
      renderReport("Against this checkout's config/prompts", asTracked),
    );

  const unreconciled = [asShipped, ...(asTracked ? [asTracked] : [])]
    .flatMap((r) => r.personas)
    .filter((p) => !p.reconciled);
  if (unreconciled.length > 0) {
    console.error(
      `\n${unreconciled.length} persona/harness rows did not reconcile with the assembled prompt.`,
    );
    process.exitCode = 1;
  }
}

await main();
