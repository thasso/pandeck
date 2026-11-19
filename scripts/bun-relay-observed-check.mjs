#!/usr/bin/env bun
/**
 * The relay's observed hosts (Task-1430 PR4) as the package runs them:
 * bundles `scripts/fixtures/bun-relay-observed.ts` with `bundle` and the
 * server plugins from `bun-bundle.mjs`, the same esbuild call that makes the
 * package's `relay.js`, and runs the bundle with the Bun running this script.
 * The fixture imports the production relay, so the changed relay code is
 * bundled through the production bundler and executes under the packaged
 * runtime. No provider name is resolved; see the fixture for its checks.
 *
 * Run it with the pinned Bun (docs/deployment.md#bun-package):
 *
 *     BUN=$(nix build --no-link --print-out-paths .#personal-assistant.bun)/bin/bun
 *     "$BUN" scripts/bun-relay-observed-check.mjs <scratch dir>
 *
 * Everything it writes, the bundle included, stays under the scratch
 * directory. It exits non-zero unless the bundle holds no unbundled import
 * and the fixture prints its success line within 30 s; a late child is
 * killed and awaited.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { bundle, repoRoot, serverBundlePlugins } from "./bun-bundle.mjs";

const SUCCESS = "bun-relay-observed: all checks passed";
const DEADLINE_MS = 30_000;

function fail(message) {
  console.error(`bun-relay-observed-check: ${message}`);
  process.exit(1);
}

const scratch = process.argv[2];
if (!scratch) fail("usage: bun scripts/bun-relay-observed-check.mjs <dir>");
if (!process.versions.bun)
  fail("run this with the packaged Bun, not Node: it checks Bun's runtime.");
const root = resolve(scratch);
mkdirSync(root, { recursive: true });

const fixture = join(repoRoot, "scripts/fixtures/bun-relay-observed.ts");
const contents = await bundle(fixture, { plugins: serverBundlePlugins() });
const artifact = join(root, "bun-relay-observed.js");
writeFileSync(artifact, contents);
const text = Buffer.from(contents).toString("utf8");

// Bundled whole: every remaining import is a runtime builtin, and the
// production relay's own text is inside.
const specifiers = new Set();
for (const pattern of [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(?\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
])
  for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
const unbundled = [...specifiers].filter(
  (specifier) => !/^(?:node|bun):/.test(specifier),
);
if (unbundled.length)
  fail(`the bundle still imports ${JSON.stringify(unbundled)}.`);
if (/vitest/.test(text)) fail("the bundle mentions vitest.");
for (const marker of [
  "the relay cannot reach this host.",
  "intercepting the named hosts",
])
  if (!text.includes(marker))
    fail(
      `the bundle lacks the production relay text ${JSON.stringify(marker)}.`,
    );

console.log(`bun: ${process.execPath} ${process.versions.bun}`);
console.log(
  `bundle: ${artifact} sha256 ${createHash("sha256").update(contents).digest("hex")} imports ${[...specifiers].sort().join(",")}`,
);

const child = spawn(process.execPath, [artifact, join(root, "run")], {
  cwd: root,
  env: { PATH: process.env.PATH ?? "", HOME: root, TMPDIR: root },
  stdio: ["ignore", "pipe", "inherit"],
});
let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk;
  process.stdout.write(chunk);
});
const exited = new Promise((done) =>
  child.on("exit", (code, signal) => done({ code, signal })),
);
let timer;
const late = new Promise((done) => {
  timer = setTimeout(() => done(undefined), DEADLINE_MS);
});
const result = await Promise.race([exited, late]);
clearTimeout(timer);
if (!result) {
  child.kill("SIGKILL");
  await exited;
  fail(`the fixture did not finish within ${DEADLINE_MS / 1000} s.`);
}
if (result.code !== 0)
  fail(`the fixture exited ${result.code ?? result.signal}.`);
if (!output.split("\n").includes(SUCCESS))
  fail("the fixture exited 0 without its success line.");
console.log("bun-relay-observed-check: passed");
