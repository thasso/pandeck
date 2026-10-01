#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractChangelogSection } from "./release-utils.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [version, output, ...rest] = process.argv.slice(2);
if (!version || rest.length > 0) {
  console.error(
    "Usage: node scripts/release-notes.mjs <version> [output-file]",
  );
  process.exit(2);
}

try {
  const notes = extractChangelogSection(
    readFileSync(`${repoRoot}/CHANGELOG.md`, "utf8"),
    version,
  );
  if (output) writeFileSync(output, notes);
  else process.stdout.write(notes);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
