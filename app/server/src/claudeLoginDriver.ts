/**
 * The official Claude CLI's subscription login, as a child process: where the
 * CLI is, its arguments, the minimal environment and output sanitising, shared
 * by the server's own login terminal (`claudeLoginTerminal.ts`) and the
 * gateway's Claude login driver below. It imports no server state, so a
 * gateway process can load it without a `DATA_DIR`.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { errorText } from "./errors.ts";
import { packagedClaudeCliPath } from "./runtimeAssets.ts";

/** How long a SIGTERM'd child has before SIGKILL. */
export const KILL_AFTER_MS = 5_000;

/** Resolve the exact native Claude CLI bundled with the installed Agent SDK. */
export function bundledClaudeCliPath(): string {
  const packaged = packagedClaudeCliPath();
  if (packaged) return packaged;
  // The Nix package wraps the bundled native executable with its glibc loader;
  // an unpackaged NixOS checkout cannot execute that raw FHS binary, so local
  // development deliberately uses the CLI already available on PATH.
  if (process.env.NODE_ENV !== "production") return "claude";
  const packageArch =
    process.arch === "arm64"
      ? "arm64"
      : process.arch === "x64"
        ? "x64"
        : process.arch;
  const packageName = `@anthropic-ai/claude-agent-sdk-${process.platform}-${packageArch}`;
  try {
    const localRequire = createRequire(import.meta.url);
    const sdkEntry = localRequire.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const packageJson = sdkRequire.resolve(`${packageName}/package.json`);
    return join(
      dirname(packageJson),
      process.platform === "win32" ? "claude.exe" : "claude",
    );
  } catch {
    // Development environments may intentionally use a separately installed CLI.
    return "claude";
  }
}

/** The login child's arguments: the official CLI's subscription login. */
export const CLAUDE_LOGIN_ARGS = ["auth", "login", "--claudeai"];

/** Minimal login child environment: never the server's tokens or app secret. */
export function claudeLoginEnvironmentFrom(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "TZ",
    "LANG",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NIX_SSL_CERT_FILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "CLAUDE_CONFIG_DIR",
  ]);
  const env = Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (allowed.has(entry[0]) || entry[0].startsWith("LC_")),
    ),
  );
  return { ...env, NO_COLOR: "1", BROWSER: "false" };
}

/** Output is display-only: drop terminal controls and bound retained/browser-visible text. */
export function sanitizeClaudeLoginOutput(value: string): string {
  return value
    .replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

const LOGIN_URL_RE = /https:\/\/\S+oauth\S*/;

/**
 * The gateway's Claude login driver (plan Task-1385, M11; `gateway/logins.ts`
 * `LoginDriver`): the same official CLI login as a run here, as an isolated
 * child whose `CLAUDE_CONFIG_DIR` is the login's fresh directory, so its
 * credential lands there. Output goes out sanitised, with the first
 * authorization URL also as a `url` event; a line typed in goes to its
 * stdin and is never logged. A cancel sends SIGTERM, then SIGKILL after 5 s.
 */
export function claudeLoginDriver(
  configDir: string,
  events: { output(text: string): void; url(url: string): void },
): { input(text: string): void; cancel(): void; done: Promise<void> } {
  const child = spawn(bundledClaudeCliPath(), [...CLAUDE_LOGIN_ARGS], {
    env: {
      ...claudeLoginEnvironmentFrom(process.env),
      CLAUDE_CONFIG_DIR: configDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let urlSent = false;
  const output = (raw: string): void => {
    const text = sanitizeClaudeLoginOutput(raw);
    if (!text) return;
    events.output(text);
    const url = urlSent ? undefined : LOGIN_URL_RE.exec(text)?.[0];
    if (url) {
      urlSent = true;
      events.url(url);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.stdin.on("error", () => child.kill("SIGTERM"));
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => {
      if (child.pid === undefined)
        reject(
          new Error(
            `Could not start the official Claude CLI: ${errorText(error)}`,
          ),
        );
    });
    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `Claude login stopped (${signal}).`
              : `Claude login exited with code ${code ?? "unknown"}.`,
          ),
        );
    });
  });
  return {
    input: (text) => {
      if (child.exitCode === null) child.stdin.write(`${text}\n`);
    },
    cancel: () => {
      if (child.exitCode !== null || killTimer) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
      killTimer.unref?.();
    },
    done,
  };
}
