#!/usr/bin/env node
/** Hash-verified dev model install via Nix, matching the STT install command. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { models } = JSON.parse(
  readFileSync(join(root, "config/tts-models.json"), "utf8"),
);
const requested = process.argv[2];
const model = requested
  ? models.find((entry) => entry.id === requested)
  : models[0];
if (!model) {
  console.error(
    `Unknown TTS model: ${requested}. Available: ${models.map((entry) => entry.id).join(", ")}`,
  );
  process.exit(1);
}
const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : join(root, "assistant-data");
const link = join(dataDir, "models", "tts", model.id);
mkdirSync(dirname(link), { recursive: true });
const attr = `.#tts-model-${model.id}`;
console.log(
  `Building ${attr}. First run downloads weights; the symlink is a GC root.`,
);
execFileSync("nix", ["build", attr, "--out-link", link], {
  cwd: root,
  stdio: "inherit",
});
if (!model.required.every((name) => existsSync(join(link, name))))
  throw new Error("Unexpected model layout.");
console.log(
  `Installed ${model.id} -> ${link}. Restart the dev server to rediscover capabilities.`,
);
