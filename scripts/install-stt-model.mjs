#!/usr/bin/env node
/**
 * Install a speech-to-text model for local dev: `pnpm run stt:model [<id>]`.
 *
 * This is deliberately a thin wrapper around `nix build --out-link`, not a
 * downloader. Nix already fetches and verifies the exact hash pinned in
 * `config/stt-models.json` — the same artifact prod gets — and `--out-link` does
 * two useful things at once: it symlinks the store path into the DATA_DIR
 * fallback slot the server already probes (so no env var is needed), and it
 * registers an indirect GC root so garbage collection cannot strand it.
 *
 * The result is a symlink, not a 631 MB copy. Idempotent: re-running just
 * refreshes the link.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = join(repoRoot, "config", "stt-models.json");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8")).models ?? [];
if (catalog.length === 0) fail(`no models catalogued in ${catalogPath}`);

const requested = process.argv[2];
const entry = requested
  ? catalog.find((model) => model.id === requested)
  : catalog[0];
if (!entry) {
  fail(
    `unknown model id "${requested}". Catalogued: ${catalog.map((model) => model.id).join(", ")}`,
  );
}

// Mirrors the server's DATA_DIR fallback (see speech/sttConfig.ts). Dev uses the
// repo-local data dir, which is not the backed-up production DATA_DIR.
const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(repoRoot, "assistant-data");
const linkPath = join(dataDir, "models", "stt", entry.id);
mkdirSync(dirname(linkPath), { recursive: true });

const attr = `.#stt-model-${entry.id}`;
console.log(`Building ${attr} (${entry.label})`);
console.log(
  "First run downloads the weights once; later runs are a store cache hit.\n",
);

try {
  execFileSync("nix", ["build", attr, "--out-link", linkPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch {
  fail(
    `\`nix build ${attr}\` failed. Nix is required for this command; the model itself is optional (dictation stays disabled without it).`,
  );
}

if (!existsSync(join(linkPath, entry.tokens))) {
  fail(
    `${linkPath} does not contain ${entry.tokens} — the build produced an unexpected layout`,
  );
}

console.log(`\nInstalled ${entry.id} -> ${linkPath}`);
console.log(
  "The dev server picks this up with no further configuration; restart it if it is already running.",
);
