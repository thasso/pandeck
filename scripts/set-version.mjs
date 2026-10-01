#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setRepositoryVersion } from "./release-utils.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
  console.error("Usage: node scripts/set-version.mjs <version>");
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}

try {
  const files = setRepositoryVersion(repoRoot, args[0]);
  console.log(`Set ${files.join(", ")} to ${args[0]}.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
