import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

declare const __ASSISTANT_BUN_BUNDLE__: boolean | undefined;

const isBundled =
  typeof __ASSISTANT_BUN_BUNDLE__ !== "undefined" && __ASSISTANT_BUN_BUNDLE__;
const configuredRoot = process.env.ASSISTANT_RUNTIME_DIR?.trim() || undefined;
const configuredClaudeCli =
  process.env.ASSISTANT_CLAUDE_CLI_BIN?.trim() || undefined;
if (isBundled && !configuredRoot)
  throw new Error(
    "ASSISTANT_RUNTIME_DIR is required by the packaged server executable.",
  );
export const IS_PACKAGED_RUNTIME = isBundled || configuredRoot !== undefined;
if (configuredRoot && !isAbsolute(configuredRoot))
  throw new Error(
    `ASSISTANT_RUNTIME_DIR must be an absolute path (got "${configuredRoot}")`,
  );

/**
 * Root of the immutable assets that belong to this server build.
 *
 * Development resolves to the checkout. Packaged bundles set
 * `ASSISTANT_RUNTIME_DIR` so the bundled module uses the explicit installed
 * layout rather than inferring asset paths from its own location.
 */
export const RUNTIME_ASSET_ROOT =
  configuredRoot ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Resolve one build-owned runtime asset without consulting the agent cwd. */
function runtimeAssetPath(...segments: string[]): string {
  return join(RUNTIME_ASSET_ROOT, ...segments);
}

export const WEB_DIST_DIR = configuredRoot
  ? runtimeAssetPath("web")
  : runtimeAssetPath("app", "web", "dist");
export const PACKAGED_CONFIG_DIR = runtimeAssetPath("config");
export const PACKAGED_PROMPTS_DIR = runtimeAssetPath("config", "prompts");
export const PACKAGED_MIGRATIONS_DIR = configuredRoot
  ? runtimeAssetPath("migrations")
  : runtimeAssetPath("app", "server", "src", "db", "migrations");
export const PACKAGED_MIGRATIONS_LOCK_PATH = configuredRoot
  ? runtimeAssetPath("migrations.lock.json")
  : runtimeAssetPath("app", "server", "src", "db", "migrations.lock.json");
export const PACKAGED_PARCEL_WATCHER_ADDON = runtimeAssetPath(
  "native",
  "watcher.node",
);
export const PACKAGED_PARCEL_WATCHER_WRAPPER = runtimeAssetPath(
  "native",
  "watcher-wrapper.js",
);
export const PACKAGED_XHR_SYNC_WORKER = runtimeAssetPath(
  "workers",
  "xhr-sync-worker.js",
);
/** Playwright MCP CLI installed with the server, never fetched at runtime. */
export const PLAYWRIGHT_MCP_CLI_PATH = configuredRoot
  ? runtimeAssetPath("browser-mcp", "cli.js")
  : join(
      dirname(
        fileURLToPath(import.meta.resolve("@playwright/mcp/package.json")),
      ),
      "cli.js",
    );
const PACKAGED_PHOTON_WASM = runtimeAssetPath(
  "native",
  "photon",
  "photon_rs_bg.wasm",
);

/**
 * The separately installed Claude CLI used by SDK subprocesses and login.
 * Undefined in a checkout so the SDK and login keep their normal development
 * lookup behavior.
 */
export function packagedClaudeCliPath(): string | undefined {
  if (configuredClaudeCli) return configuredClaudeCli;
  return configuredRoot ? runtimeAssetPath("claude", "claude") : undefined;
}

/** SDK option fragment shared by interactive, helper, and usage queries. */
export function packagedClaudeSdkOptions():
  { pathToClaudeCodeExecutable: string } | Record<string, never> {
  const path = packagedClaudeCliPath();
  return path ? { pathToClaudeCodeExecutable: path } : {};
}

/** Refuse a packaged boot before binding when an explicit runtime asset is missing. */
export function assertPackagedRuntimeAssets(): void {
  if (!configuredRoot) return;
  const required = [
    runtimeAssetPath("package.json"),
    join(WEB_DIST_DIR, "index.html"),
    join(PACKAGED_CONFIG_DIR, "app.json"),
    join(PACKAGED_CONFIG_DIR, "host-tools.json"),
    join(PACKAGED_CONFIG_DIR, "stt-models.json"),
    join(PACKAGED_PROMPTS_DIR, "assistant.md"),
    PACKAGED_MIGRATIONS_DIR,
    PACKAGED_MIGRATIONS_LOCK_PATH,
    PACKAGED_PARCEL_WATCHER_ADDON,
    PACKAGED_PARCEL_WATCHER_WRAPPER,
    PACKAGED_PHOTON_WASM,
    runtimeAssetPath("native", "photon", "photon_rs.js"),
    runtimeAssetPath("claude", "claude"),
    PLAYWRIGHT_MCP_CLI_PATH,
    runtimeAssetPath("browser-mcp", "package.json"),
    runtimeAssetPath("browser-mcp", "playwright-core", "package.json"),
    PACKAGED_XHR_SYNC_WORKER,
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0)
    throw new Error(
      `Packaged runtime assets are missing:\n${missing.map((path) => `- ${path}`).join("\n")}`,
    );
}
