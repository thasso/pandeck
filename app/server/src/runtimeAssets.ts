import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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
export const KOKORO_SIDECAR_PATH = configuredRoot
  ? runtimeAssetPath("speech", "kokoroSidecar.py")
  : runtimeAssetPath("app", "server", "src", "speech", "kokoroSidecar.py");
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
/** The Initiative layout worker: its bundle when packaged, else its source. */
export const INITIATIVE_LAYOUT_WORKER = configuredRoot
  ? runtimeAssetPath("workers", "initiative-layout-worker.js")
  : runtimeAssetPath("app", "server", "src", "initiativeLayoutWorker.ts");
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
 * The platform packages that may carry the Agent SDK's native CLI, in the
 * SDK's own lookup order: on Linux the libc this process runs on goes first.
 */
export function claudeCliPackageNames(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = platform === "linux" && runsOnMusl(),
): string[] {
  const base = "@anthropic-ai/claude-agent-sdk";
  if (platform !== "linux") return [`${base}-${platform}-${arch}`];
  const glibc = `${base}-linux-${arch}`;
  return musl ? [`${glibc}-musl`, glibc] : [glibc, `${glibc}-musl`];
}

function runsOnMusl(): boolean {
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header !== undefined && !report.header.glibcVersionRuntime;
}

let sdkClaudeCli: string | undefined;

/** The native CLI the installed Agent SDK ships for this platform. */
function sdkClaudeCliPath(): string {
  if (sdkClaudeCli) return sdkClaudeCli;
  const candidates = claudeCliPackageNames();
  const executable = process.platform === "win32" ? "claude.exe" : "claude";
  try {
    const sdkRequire = createRequire(
      createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
    );
    for (const name of candidates) {
      try {
        const path = join(
          dirname(sdkRequire.resolve(`${name}/package.json`)),
          executable,
        );
        if (existsSync(path)) return (sdkClaudeCli = path);
      } catch {
        // Not installed for this platform; try the next candidate.
      }
    }
  } catch {
    // The SDK itself is missing; reported below like a missing binary.
  }
  throw new Error(
    `The Claude CLI that comes with the Agent SDK is not installed (${candidates.join(" or ")}). ` +
      "Reinstall the dependencies, or set ASSISTANT_CLAUDE_CLI_BIN to a Claude CLI.",
  );
}

/**
 * The one Claude CLI every Claude child runs: SDK sessions, helpers, usage,
 * login and the sign-in check, so they never differ and never fall back to a
 * `claude` the user installed. The explicit override wins, then the packaged
 * runtime's copy, then the binary the installed Agent SDK ships. Throws, naming
 * what is missing, rather than guessing.
 */
export function claudeCliPath(): string {
  if (configuredClaudeCli) return configuredClaudeCli;
  if (configuredRoot) return runtimeAssetPath("claude", "claude");
  return sdkClaudeCliPath();
}

/** SDK option fragment shared by interactive, helper, and usage queries. */
export function claudeSdkExecutableOptions(): {
  pathToClaudeCodeExecutable: string;
} {
  return { pathToClaudeCodeExecutable: claudeCliPath() };
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
    join(PACKAGED_CONFIG_DIR, "tts-models.json"),
    KOKORO_SIDECAR_PATH,
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
    INITIATIVE_LAYOUT_WORKER,
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0)
    throw new Error(
      `Packaged runtime assets are missing:\n${missing.map((path) => `- ${path}`).join("\n")}`,
    );
}
