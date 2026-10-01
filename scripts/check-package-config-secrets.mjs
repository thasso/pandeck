#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG_PATH = join(repoRoot, "config", "app.json");
const SECRET_FIELD_NAME =
  /(?:secrets?|tokens?|passwords?|privatekeys?|cookies?|credentials?|apikeys?)$/i;

function normalizedFieldName(name) {
  return name.replace(/[^a-z0-9]/gi, "");
}

/** Return JSON paths whose field names indicate packageable secret material. */
export function forbiddenPackageConfigPaths(value, path = "$") {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((item, index) =>
      forbiddenPackageConfigPaths(item, `${path}[${index}]`),
    );

  return Object.entries(value).flatMap(([name, child]) => {
    const childPath = `${path}.${name}`;
    if (SECRET_FIELD_NAME.test(normalizedFieldName(name))) return [childPath];
    return forbiddenPackageConfigPaths(child, childPath);
  });
}

/** Parse and reject a config without including any field value in diagnostics. */
export function assertPackageConfigHasNoSecrets(configPath) {
  let source;
  try {
    source = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(`Cannot read package config at ${configPath}.`);
  }

  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error(`Package config at ${configPath} is not valid JSON.`);
  }
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error(`Package config at ${configPath} must be a JSON object.`);

  const forbidden = forbiddenPackageConfigPaths(config);
  if (forbidden.length > 0)
    throw new Error(
      `Package config at ${configPath} contains forbidden secret field(s): ${forbidden.join(", ")}. Supply secrets through the approved runtime environment variables; see docs/credential-distribution.md.`,
    );
}

function configPathFromArgs(args) {
  if (args.length === 0) return DEFAULT_CONFIG_PATH;
  if (args.length === 2 && args[0] === "--config") return resolve(args[1]);
  throw new Error(
    "Usage: node scripts/check-package-config-secrets.mjs [--config <path>]",
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const configPath = configPathFromArgs(process.argv.slice(2));
    assertPackageConfigHasNoSecrets(configPath);
    console.log(
      `check-package-config-secrets: ${configPath} contains no secret-shaped fields.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Package config secret check failed.",
    );
    process.exitCode = 1;
  }
}
