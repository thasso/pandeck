/**
 * The gateway's child entries, run by the same runtime as the entry that
 * spawns them: the source module under tsx, else the bundle beside this one
 * (`docs/deployment.md#bun-package`).
 */
import { fileURLToPath } from "node:url";

const SOURCES = {
  "codex-renew": "codexRenewMain",
  "claude-login": "claudeLoginMain",
  "codex-login": "codexLoginMain",
} as const;

export function childEntry(name: keyof typeof SOURCES): {
  file: string;
  args: string[];
} {
  const path = import.meta.url.endsWith(".ts")
    ? `../${SOURCES[name]}.ts`
    : `./${name}.js`;
  return {
    file: process.execPath,
    args: [...process.execArgv, fileURLToPath(new URL(path, import.meta.url))],
  };
}
