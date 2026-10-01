#!/usr/bin/env node
import { resolve } from "node:path";
import { measureTools } from "./toolMeasurement.ts";

const valueAfter = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ? resolve(value) : undefined;
};

const dataDirValue = valueAfter("--data-dir");
const claudeProjectsDirValue = process.argv.includes("--no-claude-transcripts")
  ? ""
  : valueAfter("--claude-projects-dir");
const payloadProbeFileValue = valueAfter("--payload-probe");
const report = measureTools({
  ...(dataDirValue !== undefined ? { dataDir: dataDirValue } : {}),
  ...(claudeProjectsDirValue !== undefined
    ? { claudeProjectsDir: claudeProjectsDirValue }
    : {}),
  ...(payloadProbeFileValue !== undefined
    ? { payloadProbeFile: payloadProbeFileValue }
    : {}),
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
