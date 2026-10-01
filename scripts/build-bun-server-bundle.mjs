#!/usr/bin/env bun

import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { write } from "bun";
import {
  SERVER_BUNDLE_DEFINE,
  bundle,
  dependencyRoot,
  directDependencyRoot,
  repoRoot,
  serverBundlePlugins,
} from "./bun-bundle.mjs";
import { assertPackageConfigHasNoSecrets } from "./check-package-config-secrets.mjs";

const outputArg = process.argv[2];
if (!outputArg) {
  console.error("usage: build-bun-server-bundle.mjs <output-directory>");
  process.exit(2);
}
const outputDir = resolve(outputArg);

// config/app.json is copied into the package below. Refuse secret-shaped fields
// before touching the output so no package can carry deployment credentials.
assertPackageConfigHasNoSecrets(join(repoRoot, "config", "app.json"));

function copy(source, destination, mode) {
  const target = join(outputDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  if (mode !== undefined) chmodSync(target, mode);
}

function platformArch() {
  if (process.platform !== "linux")
    throw new Error("The Bun server bundle currently targets Linux only.");
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return arch;
}

const arch = platformArch();
const watcherPackage = `@parcel/watcher-linux-${arch}-glibc`;
const watcherAddon = join(
  dependencyRoot("@parcel/watcher", watcherPackage),
  "watcher.node",
);
const watcherWrapperSource = join(
  directDependencyRoot("@parcel/watcher"),
  "wrapper.js",
);
const claudePackage = `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
const claudeCli = join(
  dependencyRoot("@anthropic-ai/claude-agent-sdk", claudePackage),
  "claude",
);
const playwrightMcpRoot = directDependencyRoot("@playwright/mcp");
const playwrightCoreRoot = realpathSync(
  dependencyRoot("@playwright/mcp", "playwright-core"),
);
const playwrightMcpCliSource = readFileSync(
  join(playwrightMcpRoot, "cli.js"),
  "utf8",
);
const playwrightMcpRequireReplacements = [
  [
    "require('playwright-core/lib/utilsBundle')",
    "require('./playwright-core/lib/utilsBundle')",
  ],
  [
    "require('playwright-core/lib/coreBundle')",
    "require('./playwright-core/lib/coreBundle')",
  ],
];
if (!playwrightMcpCliSource.startsWith("#!"))
  throw new Error("Playwright MCP CLI no longer starts with a shebang.");
let packagedPlaywrightMcpCli = playwrightMcpCliSource.slice(
  playwrightMcpCliSource.indexOf("\n") + 1,
);
for (const [upstream, packaged] of playwrightMcpRequireReplacements) {
  if (!packagedPlaywrightMcpCli.includes(upstream))
    throw new Error(
      `Playwright MCP CLI loader changed; expected ${JSON.stringify(upstream)}.`,
    );
  packagedPlaywrightMcpCli = packagedPlaywrightMcpCli.replace(
    upstream,
    packaged,
  );
}
const photonRoot = dependencyRoot(
  "@earendil-works/pi-coding-agent",
  "@silvia-odwyer/photon-node",
);
const photonSource = join(photonRoot, "photon_rs.js");
const photonWasm = join(photonRoot, "photon_rs_bg.wasm");
const jsdomRoot = directDependencyRoot("jsdom");
const xhrWorkerSource = join(
  jsdomRoot,
  "lib/jsdom/living/xhr/xhr-sync-worker.js",
);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

const plugins = serverBundlePlugins();

const serverBundle = await bundle(join(repoRoot, "app/server/src/index.ts"), {
  define: SERVER_BUNDLE_DEFINE,
  plugins,
});
const workerBundle = await bundle(xhrWorkerSource, { plugins });
const watcherWrapperBundle = await bundle(watcherWrapperSource, {
  format: "cjs",
});

mkdirSync(join(outputDir, "workers"), { recursive: true });
mkdirSync(join(outputDir, "native"), { recursive: true });
copy(process.execPath, "personal-assistant-server", 0o755);
await write(join(outputDir, "server.js"), serverBundle);
await write(join(outputDir, "workers", "xhr-sync-worker.js"), workerBundle);
await write(
  join(outputDir, "native", "watcher-wrapper.js"),
  watcherWrapperBundle,
);

copy(join(repoRoot, "package.json"), "package.json");
copy(join(repoRoot, "LICENSE"), "LICENSE");
copy(join(repoRoot, "NOTICE"), "NOTICE");
copy(join(repoRoot, "app/web/dist"), "web");
copy(join(repoRoot, "config/app.json"), "config/app.json");
copy(join(repoRoot, "config/host-tools.json"), "config/host-tools.json");
copy(join(repoRoot, "config/stt-models.json"), "config/stt-models.json");
copy(join(repoRoot, "config/prompts"), "config/prompts");
copy(join(repoRoot, "app/server/src/db/migrations"), "migrations");
copy(
  join(repoRoot, "app/server/src/db/migrations.lock.json"),
  "migrations.lock.json",
);
copy(watcherAddon, "native/watcher.node");
copy(photonSource, "native/photon/photon_rs.js");
copy(photonWasm, "native/photon/photon_rs_bg.wasm");
copy(claudeCli, "claude/claude", 0o755);
copy(join(playwrightMcpRoot, "package.json"), "browser-mcp/package.json");
copy(playwrightCoreRoot, "browser-mcp/playwright-core");
// pnpm adds a package-local node_modules/.bin entry to its virtual-store copy.
// The CLI does not use it, and the Bun runtime must contain no node_modules.
rmSync(join(outputDir, "browser-mcp", "playwright-core", "node_modules"), {
  recursive: true,
  force: true,
});
// Both CLIs are invoked through the packaged Bun executable. Drop Node
// shebangs so Nix cannot rewrite them into a Node runtime closure reference.
rmSync(join(outputDir, "browser-mcp", "playwright-core", "cli.js"));
await write(join(outputDir, "browser-mcp", "cli.js"), packagedPlaywrightMcpCli);

console.log(`Built Bun server bundle at ${outputDir}`);
