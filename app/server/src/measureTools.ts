#!/usr/bin/env node
import { resolve } from "node:path";
import { measureTools } from "./toolMeasurement.ts";

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? resolve(value) : undefined;
};

const dataDirValue = valueAfter("--data-dir");
// Claude CLI transcripts are read from every account under the data dir's
// `credential-profiles/`; `--no-claude-transcripts` skips them.
const skipClaudeTranscripts = process.argv.includes("--no-claude-transcripts");
const payloadProbeFileValue = valueAfter("--payload-probe");
const report = measureTools({
  ...(dataDirValue !== undefined ? { dataDir: dataDirValue } : {}),
  ...(skipClaudeTranscripts ? { credentialProfilesRoot: "" } : {}),
  ...(payloadProbeFileValue !== undefined
    ? { payloadProbeFile: payloadProbeFileValue }
    : {}),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
