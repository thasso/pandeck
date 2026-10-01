import { pathToFileURL } from "node:url";
import {
  addArtifactNotice,
  boundNativeOutput,
  type ReadWindowDecision,
} from "./outputPolicy.ts";

const readDecision: ReadWindowDecision = {
  input: { path: "events.jsonl", limit: 120 },
  boundedByDefault: true,
  logLike: true,
  fileBytes: 2_000_000,
  startLine: 1,
  limit: 120,
};

const samples = [
  {
    name: "successful production build",
    toolName: "bash",
    toolInput: { command: "pnpm run build" },
    raw: `${"vite transform detail\n".repeat(4_000)}built in 2.3s\n`,
    exitCode: 0,
  },
  {
    name: "failing test run",
    toolName: "bash",
    toolInput: { command: "pnpm test" },
    raw: `${"test progress\n".repeat(4_000)}FAIL example.test.ts\nExpected 2, received 1\n`,
    isError: true,
    exitCode: 1,
  },
  {
    name: "broad diff",
    toolName: "bash",
    toolInput: { command: "git diff" },
    raw: `${"@@ hunk @@\n+new line\n-old line\n".repeat(2_000)}`,
    exitCode: 0,
  },
  {
    name: "large JSONL default read window",
    toolName: "read",
    toolInput: readDecision.input,
    raw: `${'{"event":"sample"}\n'.repeat(2_000)}`,
    readDecision,
  },
] as const;

function bytes(value: number): string {
  return `${(value / 1024).toFixed(1)} KiB`;
}

export function outputPolicyBenchmark(): string {
  const results = samples.map((sample) => {
    const bounded = boundNativeOutput(sample);
    return {
      sample,
      bounded: bounded.elided
        ? addArtifactNotice(bounded, {
            path: `/data/session-artifacts/benchmark/tool-output/${sample.toolName}.log`,
            url: `/api/session-artifacts/benchmark/tool-output/${sample.toolName}.log`,
          })
        : bounded,
    };
  });
  const beforeBytes = results.reduce(
    (total, row) => total + Buffer.byteLength(row.sample.raw),
    0,
  );
  const afterBytes = results.reduce(
    (total, row) => total + Buffer.byteLength(row.bounded.text),
    0,
  );
  const largestBefore = Math.max(
    ...results.map((row) => Buffer.byteLength(row.sample.raw)),
  );
  const largestAfter = Math.max(
    ...results.map((row) => Buffer.byteLength(row.bounded.text)),
  );
  // Result-only context contribution. The processed-input row models the same
  // retained transcript being carried through three later provider requests.
  const occupancyBefore = Math.ceil(beforeBytes / 4);
  const occupancyAfter = Math.ceil(afterBytes / 4);
  const requests = 3;
  const processedBefore = occupancyBefore * requests;
  const processedAfter = occupancyAfter * requests;
  const lines = [
    "# Bounded output benchmark",
    "",
    "Synthetic representative outputs; UTF-8 bytes measured exactly, token rows use 4 chars/token.",
    "",
    "| Metric | Before | After | Reduction |",
    "| --- | ---: | ---: | ---: |",
  ];
  const row = (
    name: string,
    before: number,
    after: number,
    format: (value: number) => string = String,
  ) =>
    `| ${name} | ${format(before)} | ${format(after)} | ${(((before - after) / before) * 100).toFixed(1)}% |`;
  lines.push(
    row("largest result size", largestBefore, largestAfter, bytes),
    row("retained result bytes", beforeBytes, afterBytes, bytes),
    row(
      "result context occupancy (est. tokens)",
      occupancyBefore,
      occupancyAfter,
    ),
    row(
      `processed input over ${requests} later requests (est. tokens)`,
      processedBefore,
      processedAfter,
    ),
    "",
    "| Sample | Raw | Retained | Mode |",
    "| --- | ---: | ---: | --- |",
    ...results.map(
      ({ sample, bounded }) =>
        `| ${sample.name} | ${bytes(Buffer.byteLength(sample.raw))} | ${bytes(Buffer.byteLength(bounded.text))} | ${bounded.mode} |`,
    ),
  );
  return `${lines.join("\n")}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.stdout.write(outputPolicyBenchmark());
