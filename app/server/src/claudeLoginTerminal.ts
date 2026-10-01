import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { releaseChildOomScore } from "./childOomScore.ts";
import type {
  ClaudeLoginClientMessage,
  ClaudeLoginServerMessage,
  ClaudeLoginTerminalStatus,
} from "@assistant/shared";
import {
  claudeProfileEnvironment,
  claudeProfileHasCredential,
  clearCredentialProfileLoginState,
  credentialProfileById,
  setCredentialProfileLoginState,
  subscribeCredentialProfileDeleted,
} from "./credentialProfiles.ts";
import { errorText } from "./errors.ts";
import { packagedClaudeCliPath } from "./runtimeAssets.ts";

const MAX_OUTPUT_CHARS = 64_000;
const MAX_INPUT_CHARS = 8_192;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const FINISHED_RETENTION_MS = 2 * 60_000;

type SpawnClaudeLogin = (
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

let spawnClaudeLogin: SpawnClaudeLogin = (executable, args, options) =>
  spawn(executable, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
let loginTimeoutMs = DEFAULT_TIMEOUT_MS;

interface LoginRun {
  profileId: string;
  child: ChildProcessWithoutNullStreams;
  viewers: Set<WebSocket>;
  status: ClaudeLoginTerminalStatus;
  output: string;
  startedAt: number;
  error?: string;
  finished: boolean;
  timeout: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
}

const runs = new Map<string, LoginRun>();

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

/** Minimal child environment: login never needs the server's integration tokens or app secret. */
function claudeLoginEnvironment(profileId: string): Record<string, string> {
  const source = claudeProfileEnvironment(profileId);
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
      ([key]) => allowed.has(key) || key.startsWith("LC_"),
    ),
  );
  return { ...env, NO_COLOR: "1", BROWSER: "false" };
}

/** Output is display-only: drop terminal controls and bound retained/browser-visible text. */
function sanitizeClaudeLoginOutput(value: string): string {
  return value
    .replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
}

function send(viewer: WebSocket, message: ClaudeLoginServerMessage): void {
  if (viewer.readyState !== 1) return;
  try {
    viewer.send(JSON.stringify(message));
  } catch {
    /* a close races buffered output */
  }
}

function broadcast(run: LoginRun, message: ClaudeLoginServerMessage): void {
  for (const viewer of run.viewers) send(viewer, message);
}

function appendOutput(run: LoginRun, raw: string): void {
  if (run.finished) return;
  let chunk = sanitizeClaudeLoginOutput(raw);
  if (!chunk) return;
  const remaining = MAX_OUTPUT_CHARS - run.output.length;
  if (remaining <= 0) return;
  if (chunk.length > remaining) {
    const suffix = "\n[Further terminal output was truncated.]\n";
    chunk =
      remaining <= suffix.length
        ? suffix.slice(0, remaining)
        : `${chunk.slice(0, remaining - suffix.length)}${suffix}`;
  }
  run.output += chunk;
  broadcast(run, { type: "output", chunk });
}

function retainFinished(run: LoginRun): void {
  run.retention = setTimeout(() => {
    if (runs.get(run.profileId) === run) runs.delete(run.profileId);
  }, FINISHED_RETENTION_MS);
  run.retention.unref?.();
}

function finish(
  run: LoginRun,
  status: ClaudeLoginTerminalStatus,
  message?: string,
): void {
  if (run.finished) return;
  run.finished = true;
  run.status = status;
  if (message !== undefined) run.error = message;
  clearTimeout(run.timeout);
  if (status === "ready") clearCredentialProfileLoginState(run.profileId);
  else if (status === "error" && credentialProfileById(run.profileId)) {
    setCredentialProfileLoginState(run.profileId, {
      status: "error",
      error: message?.slice(0, 180) ?? "Claude login failed.",
    });
  } else if (status === "cancelled")
    clearCredentialProfileLoginState(run.profileId);
  broadcast(run, {
    type: "status",
    status,
    ...(message ? { error: message } : {}),
  });
  retainFinished(run);
}

function startRun(profileId: string): LoginRun {
  const profile = credentialProfileById(profileId);
  if (!profile || profile.provider !== "claude")
    throw new Error("That is not a Claude credential profile.");
  setCredentialProfileLoginState(profileId, { status: "connecting" });
  const env = claudeLoginEnvironment(profileId);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnClaudeLogin(
      bundledClaudeCliPath(),
      ["auth", "login", "--claudeai"],
      {
        env,
        windowsHide: true,
      },
    );
  } catch (error) {
    const message = `Could not start the official Claude CLI: ${errorText(error)}`;
    setCredentialProfileLoginState(profileId, {
      status: "error",
      error: message.slice(0, 180),
    });
    throw new Error(message);
  }
  releaseChildOomScore(child.pid);
  const run: LoginRun = {
    profileId,
    child,
    viewers: new Set(),
    status: "connecting",
    output: "Starting the official Claude login…\n",
    startedAt: Date.now(),
    finished: false,
    timeout: setTimeout(() => undefined, 1),
  };
  runs.set(profileId, run);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => appendOutput(run, chunk));
  child.stderr.on("data", (chunk: string) => appendOutput(run, chunk));
  child.stdin.on("error", (error) =>
    finish(run, "error", `Claude login input closed: ${errorText(error)}`),
  );
  child.on("error", (error) =>
    finish(
      run,
      "error",
      `Could not start the official Claude CLI: ${errorText(error)}`,
    ),
  );
  child.on("close", (code, signal) => {
    if (run.finished) return;
    if (code === 0 && claudeProfileHasCredential(profileId)) {
      appendOutput(run, "\nClaude login completed.\n");
      finish(run, "ready");
      return;
    }
    const detail = signal
      ? `Claude login stopped (${signal}).`
      : `Claude login exited with code ${code ?? "unknown"}.`;
    finish(run, "error", detail);
  });
  clearTimeout(run.timeout);
  run.timeout = setTimeout(() => {
    if (run.finished) return;
    run.child.kill("SIGTERM");
    finish(
      run,
      "error",
      "Claude login timed out after 10 minutes. Start it again to retry.",
    );
  }, loginTimeoutMs);
  run.timeout.unref?.();
  return run;
}

function snapshot(run: LoginRun): ClaudeLoginServerMessage {
  return {
    type: "snapshot",
    profileId: run.profileId,
    status: run.status,
    output: run.output,
    startedAt: run.startedAt,
    ...(run.error ? { error: run.error } : {}),
  };
}

function handleClientMessage(run: LoginRun, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const message = parsed as Partial<ClaudeLoginClientMessage>;
  if (message.type === "cancel") {
    if (!run.finished) {
      run.child.kill("SIGTERM");
      appendOutput(run, "\nClaude login cancelled.\n");
      finish(run, "cancelled");
    }
    return;
  }
  if (
    message.type !== "input" ||
    run.finished ||
    typeof message.data !== "string"
  )
    return;
  const data = message.data.trim();
  if (!data || data.length > MAX_INPUT_CHARS) return;
  // Never append or log this value: it may be the short-lived OAuth authorization code.
  run.child.stdin.write(`${data}\n`);
}

/** Attach one authenticated browser to a single-flight, reconnectable profile login. */
export function attachClaudeLoginSocket(
  viewer: WebSocket,
  req: IncomingMessage,
): void {
  const url = new URL(
    req.url ?? "/ws/claude-login",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const profileId = url.searchParams.get("profileId") ?? "";
  let run: LoginRun;
  try {
    run = runs.get(profileId) ?? startRun(profileId);
  } catch (error) {
    send(viewer, { type: "status", status: "error", error: errorText(error) });
    viewer.close(1008, "Invalid Claude credential profile");
    return;
  }
  run.viewers.add(viewer);
  send(viewer, snapshot(run));
  viewer.on("message", (raw) => handleClientMessage(run, raw.toString()));
  const detach = () => {
    run.viewers.delete(viewer);
    if (
      run.finished &&
      run.viewers.size === 0 &&
      runs.get(run.profileId) === run
    ) {
      if (run.retention) clearTimeout(run.retention);
      runs.delete(run.profileId);
    }
  };
  viewer.on("close", detach);
  viewer.on("error", detach);
}

function cancelClaudeLoginTerminal(
  profileId: string,
  reason = "Claude login cancelled.",
  signal: NodeJS.Signals = "SIGTERM",
): void {
  const run = runs.get(profileId);
  if (!run || run.finished) return;
  run.child.kill(signal);
  appendOutput(run, `\n${reason}\n`);
  finish(run, "cancelled");
}

/** Login subprocesses are not agent turns and must never hold a deploy drain open. */
export function stopClaudeLoginTerminals(): void {
  for (const run of runs.values()) {
    clearTimeout(run.timeout);
    if (run.retention) clearTimeout(run.retention);
    if (!run.finished) {
      run.child.kill("SIGTERM");
      finish(run, "cancelled");
      if (run.retention) clearTimeout(run.retention);
    }
    for (const viewer of run.viewers) {
      try {
        viewer.close(1012, "Server restarting");
      } catch {
        /* already closed */
      }
    }
  }
  runs.clear();
}

subscribeCredentialProfileDeleted((profileId) =>
  cancelClaudeLoginTerminal(
    profileId,
    "Profile deleted; Claude login cancelled.",
    "SIGKILL",
  ),
);

/** Test seams; production callers never replace the official CLI spawn. */
export function setClaudeLoginSpawnForTests(
  value: SpawnClaudeLogin | null,
): void {
  spawnClaudeLogin =
    value ??
    ((executable, args, options) =>
      spawn(executable, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
}

export function setClaudeLoginTimeoutForTests(value: number | null): void {
  loginTimeoutMs = value ?? DEFAULT_TIMEOUT_MS;
}
