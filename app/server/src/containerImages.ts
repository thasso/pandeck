/**
 * Server-side container image pulls (`docker`), the one place allowed to hand
 * registry credentials to the CLI.
 *
 * Agent shells get no registry credentials at all: an agent asks the
 * `container_image_pull` tool for an image, the pull happens here in the server
 * process, and the image lands in the host-global Docker image store — so the
 * subsequent `docker run`/build script in a worktree finds it with no token in
 * its environment, argv, or transcript.
 *
 * Credential handling invariants (covered by `containerImages.test.ts`):
 * - A credential is only ever used for {@link GHCR_REGISTRY}. Any other
 *   registry is pulled anonymously even if a provider is passed.
 * - The token reaches `docker login` on STDIN only, never in argv or env.
 * - Every docker invocation runs with a private, temporary `DOCKER_CONFIG`
 *   (so the user's `~/.docker/config.json` and credential helpers are never
 *   consulted), removed in a `finally` on success, failure, timeout and abort.
 * - Nothing returned or logged from here is raw docker output: it goes through
 *   {@link redactRegistrySecrets} first.
 */
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseChildOomScore } from "./childOomScore.ts";
import { childProcessEnv } from "./subprocessEnv.ts";

/** The only registry we authenticate to (with the GitHub integration token). */
const GHCR_REGISTRY = "ghcr.io";

const DOCKER_BIN = "docker";
const DEFAULT_PULL_TIMEOUT_MS = 15 * 60_000;
const LOGIN_TIMEOUT_MS = 60_000;
const INSPECT_TIMEOUT_MS = 30_000;
const RUNTIME_CHECK_TIMEOUT_MS = 10_000;
const RUNTIME_CACHE_MS = 60_000;
const MAX_CAPTURED_CHARS = 256 * 1024;
const MAX_DIAGNOSTIC_CHARS = 1200;
const MAX_DIAGNOSTIC_LINES = 20;
const MAX_CONCURRENT_PULLS = 2;
const PROGRESS_INTERVAL_MS = 3_000;
const REDACTED = "«redacted»";

/** One docker CLI invocation. The single seam tests replace. */
export interface ContainerExecRequest {
  args: string[];
  /** Overlay on top of `childProcessEnv()` (we only ever set `DOCKER_CONFIG`). */
  env?: Record<string, string>;
  /** Written to stdin and closed immediately; never appears in argv. */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}

export interface ContainerExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ContainerExec = (
  req: ContainerExecRequest,
) => Promise<ContainerExecResult>;

/** Credentials for one registry; resolved lazily so anonymous pulls stay cheap. */
export interface RegistryCredential {
  username: string;
  token: string;
}

type RegistryCredentialProvider = (
  signal?: AbortSignal,
) => Promise<RegistryCredential | null>;

export interface ContainerImageRef {
  registry: string;
  repository: string;
  tag?: string;
  digest?: string;
  /** Canonical `registry/repository[:tag][@digest]` — used for pulls and dedup. */
  normalized: string;
}

export interface ContainerRuntimeStatus {
  available: boolean;
  /** Docker server version when the daemon answered. */
  version?: string;
  /** Why the runtime is unusable (redacted, single line). */
  reason?: string;
}

export interface PullContainerImageOptions {
  image: string;
  /** Pull even when the image is already in the local store. */
  refresh?: boolean;
  /** Resolves the GHCR credential; ignored for every other registry. */
  credential?: RegistryCredentialProvider;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  timeoutMs?: number;
}

export interface ContainerPullResult {
  /** Canonical reference that was pulled. */
  image: string;
  registry: string;
  status: "pulled" | "already-present";
  digest: string | null;
  imageId: string | null;
  sizeBytes: number | null;
  /** Whether registry credentials were used for this pull. */
  authenticated: boolean;
  durationMs: number;
}

/** A pull/login failure whose message is already redacted and bounded. */
export class ContainerPullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerPullError";
  }
}

const spawnDocker: ContainerExec = (req) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(DOCKER_BIN, req.args, {
      env: { ...childProcessEnv(), ...(req.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      ...(req.signal ? { signal: req.signal } : {}),
      ...(req.timeoutMs ? { timeout: req.timeoutMs } : {}),
    });
    releaseChildOomScore(child.pid);
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = capture(stdout, chunk);
      if (!req.onStdoutLine) return;
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) req.onStdoutLine(trimmed);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = capture(stderr, chunk);
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once("close", (code, signalName) => {
      if (settled) return;
      settled = true;
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr: signalName
          ? `${stderr}\ndocker was terminated by ${signalName}`
          : stderr,
      });
    });
    // A docker that exits before reading stdin (most subcommands never do)
    // fails this write with EPIPE; unhandled, that error event would crash
    // the server. Its exit already settles the call through "close".
    child.stdin?.on("error", () => {});
    child.stdin?.end(req.stdin ?? "");
  });

let exec: ContainerExec = spawnDocker;

/**
 * Run one docker command through the shared, test-injectable executor.
 *
 * Exported for `containerResidue.ts`, the only other module that talks to the
 * runtime. It deliberately carries no credentials: everything registry-related
 * stays in this module, and a caller that needs an authenticated pull asks
 * {@link pullContainerImage} instead.
 */
export function execContainerCommand(
  req: ContainerExecRequest,
): Promise<ContainerExecResult> {
  return exec(req);
}

/** Replace the docker executor (tests only); pass null to restore the real one. */
export function setContainerExecForTests(fn: ContainerExec | null): void {
  exec = fn ?? spawnDocker;
  resetContainerRuntimeCacheForTests();
}

function capture(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURED_CHARS
    ? next.slice(next.length - MAX_CAPTURED_CHARS)
    : next;
}

const REGISTRY_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/;
const REPOSITORY_RE =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-fA-F0-9]{32,}$/;

/**
 * Parse and normalize a docker reference (`ghcr.io/owner/name:tag`,
 * `node:24`, `…@sha256:…`). Rejects anything that is not a plain reference —
 * whitespace, control characters and leading `-` never reach the CLI.
 */
export function parseImageRef(raw: string): ContainerImageRef {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value)
    throw new Error("image is required, for example ghcr.io/owner/name:tag.");
  // Printable ASCII only: whitespace, control characters and exotic unicode never reach the CLI.
  if (!/^[\x21-\x7e]+$/.test(value))
    throw new Error(
      "image must contain only printable ASCII (no whitespace or control characters).",
    );
  if (value.startsWith("-")) throw new Error("image must not start with '-'.");

  let rest = value;
  let digest: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_RE.test(digest))
      throw new Error(
        `Invalid image digest "${digest}"; expected sha256:<hex>.`,
      );
  }

  let registry = "docker.io";
  const slash = rest.indexOf("/");
  const first = slash >= 0 ? rest.slice(0, slash) : "";
  if (
    slash >= 0 &&
    (first.includes(".") || first.includes(":") || first === "localhost")
  ) {
    registry = first.toLowerCase();
    rest = rest.slice(slash + 1);
    if (!REGISTRY_RE.test(registry))
      throw new Error(`Invalid registry host "${registry}".`);
  }

  let tag: string | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0 && !rest.slice(colon + 1).includes("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG_RE.test(tag)) throw new Error(`Invalid image tag "${tag}".`);
  }

  const repository =
    registry === "docker.io" && !rest.includes("/") ? `library/${rest}` : rest;
  if (!REPOSITORY_RE.test(repository))
    throw new Error(`Invalid image repository "${rest}".`);
  if (!digest && !tag) tag = "latest";

  return {
    registry,
    repository,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
    normalized: `${registry}/${repository}${tag ? `:${tag}` : ""}${digest ? `@${digest}` : ""}`,
  };
}

/**
 * Replace known secrets (and anything that looks like a token or auth header)
 * with a placeholder. Applied to every string this module surfaces.
 */
export function redactRegistrySecrets(
  text: string,
  secrets: readonly string[] = [],
): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
    out = out
      .split(Buffer.from(secret, "utf8").toString("base64"))
      .join(REDACTED);
  }
  out = out.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
    REDACTED,
  );
  out = out.replace(/(authorization\s*[:=]\s*)\S+/gi, `$1${REDACTED}`);
  out = out.replace(
    /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    `$1 ${REDACTED}`,
  );
  return out;
}

let runtimeCache: { at: number; status: ContainerRuntimeStatus } | null = null;

function resetContainerRuntimeCacheForTests(): void {
  runtimeCache = null;
}

/** Is a usable docker CLI + daemon reachable? Cached for a minute. */
export async function containerRuntimeStatus(
  signal?: AbortSignal,
): Promise<ContainerRuntimeStatus> {
  if (runtimeCache && Date.now() - runtimeCache.at < RUNTIME_CACHE_MS)
    return runtimeCache.status;
  const status = await probeContainerRuntime(signal);
  runtimeCache = { at: Date.now(), status };
  return status;
}

async function probeContainerRuntime(
  signal?: AbortSignal,
): Promise<ContainerRuntimeStatus> {
  try {
    const res = await exec({
      args: ["version", "--format", "{{.Server.Version}}"],
      ...(signal ? { signal } : {}),
      timeoutMs: RUNTIME_CHECK_TIMEOUT_MS,
    });
    if (res.code !== 0)
      return {
        available: false,
        reason:
          firstLine(redactRegistrySecrets(res.stderr || res.stdout)) ||
          "docker is not usable",
      };
    const version = res.stdout.trim();
    return { available: true, ...(version ? { version } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(message))
      return {
        available: false,
        reason: "the docker CLI is not on the server PATH",
      };
    return {
      available: false,
      reason: firstLine(redactRegistrySecrets(message)),
    };
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

const inFlight = new Map<string, Promise<ContainerPullResult>>();

/**
 * Make an image available in the local Docker image store.
 *
 * Concurrent callers asking for the same reference share one docker
 * invocation; only the first caller's `onProgress` sees pull progress.
 */
export async function pullContainerImage(
  options: PullContainerImageOptions,
): Promise<ContainerPullResult> {
  const ref = parseImageRef(options.image);
  const key = `${ref.normalized}${options.refresh ? "#refresh" : ""}`;
  const running = inFlight.get(key);
  if (running) {
    options.onProgress?.(
      `Waiting for an in-progress pull of ${ref.normalized}…`,
    );
    return running;
  }
  const run = runPull(ref, options);
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

async function runPull(
  ref: ContainerImageRef,
  options: PullContainerImageOptions,
): Promise<ContainerPullResult> {
  const started = Date.now();
  const runtime = await containerRuntimeStatus(options.signal);
  if (!runtime.available) {
    throw new ContainerPullError(
      `No usable container runtime on the server: ${runtime.reason || "docker is unavailable"}.`,
    );
  }

  if (!options.refresh) {
    const present = await inspectImage(ref, options.signal);
    if (present) {
      return {
        image: ref.normalized,
        registry: ref.registry,
        status: "already-present",
        digest: present.digest,
        imageId: present.imageId,
        sizeBytes: present.sizeBytes,
        authenticated: false,
        durationMs: Date.now() - started,
      };
    }
  }

  // Credentials are for GHCR only — a provider is ignored for any other host.
  const credential =
    ref.registry === GHCR_REGISTRY
      ? ((await options.credential?.(options.signal)) ?? null)
      : null;
  if (ref.registry === GHCR_REGISTRY && !credential) {
    throw new ContainerPullError(
      "Pulling from ghcr.io needs the GitHub integration: enable it and save a token with the read:packages scope in Settings → GitHub.",
    );
  }
  const secrets = credential
    ? [credential.token, `${credential.username}:${credential.token}`]
    : [];

  const release = await acquirePullSlot();
  const configDir = await mkdtemp(join(tmpdir(), "pa-registry-"));
  try {
    await chmod(configDir, 0o700);
    const env = { DOCKER_CONFIG: configDir };

    if (credential) {
      options.onProgress?.(`Authenticating to ${ref.registry}…`);
      const login = await exec({
        args: [
          "login",
          ref.registry,
          "--username",
          credential.username,
          "--password-stdin",
        ],
        env,
        stdin: credential.token,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: LOGIN_TIMEOUT_MS,
      });
      if (login.code !== 0) {
        throw new ContainerPullError(
          failureMessage(
            `Registry login to ${ref.registry} failed`,
            login,
            secrets,
            ref,
            true,
          ),
        );
      }
    }

    options.onProgress?.(`Pulling ${ref.normalized}…`);
    const pull = await exec({
      args: ["pull", "--", ref.normalized],
      env,
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: options.timeoutMs ?? DEFAULT_PULL_TIMEOUT_MS,
      ...(options.onProgress
        ? { onStdoutLine: pullProgressReporter(ref, options.onProgress) }
        : {}),
    });
    if (pull.code !== 0) {
      throw new ContainerPullError(
        failureMessage(
          `Pull of ${ref.normalized} failed`,
          pull,
          secrets,
          ref,
          Boolean(credential),
        ),
      );
    }

    const inspected = await inspectImage(ref, options.signal, env);
    return {
      image: ref.normalized,
      registry: ref.registry,
      status: "pulled",
      digest: inspected?.digest ?? null,
      imageId: inspected?.imageId ?? null,
      sizeBytes: inspected?.sizeBytes ?? null,
      authenticated: Boolean(credential),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof ContainerPullError) throw err;
    const message = redactRegistrySecrets(
      err instanceof Error ? err.message : String(err),
      secrets,
    );
    if (options.signal?.aborted || /abort/i.test(message))
      throw new ContainerPullError(`Pull of ${ref.normalized} was cancelled.`);
    throw new ContainerPullError(
      `Pull of ${ref.normalized} failed: ${firstLine(message)}`,
    );
  } finally {
    // Always destroy the temporary docker config, credentials and all.
    await rm(configDir, { recursive: true, force: true });
    release();
  }
}

interface InspectedImage {
  imageId: string | null;
  sizeBytes: number | null;
  digest: string | null;
}

async function inspectImage(
  ref: ContainerImageRef,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<InspectedImage | null> {
  let res: ContainerExecResult;
  try {
    res = await exec({
      args: [
        "image",
        "inspect",
        "--format",
        "{{.Id}}\t{{.Size}}\t{{json .RepoDigests}}",
        "--",
        ref.normalized,
      ],
      ...(env ? { env } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: INSPECT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  if (res.code !== 0) return null;
  const [id = "", size = "", digests = ""] = (
    firstLine(res.stdout) || ""
  ).split("\t");
  const parsedSize = Number.parseInt(size, 10);
  return {
    imageId: id || null,
    sizeBytes: Number.isFinite(parsedSize) ? parsedSize : null,
    digest: pickDigest(digests, ref),
  };
}

function pickDigest(
  repoDigestsJson: string,
  ref: ContainerImageRef,
): string | null {
  let entries: unknown;
  try {
    entries = JSON.parse(repoDigestsJson || "null");
  } catch {
    return ref.digest ?? null;
  }
  if (!Array.isArray(entries) || entries.length === 0)
    return ref.digest ?? null;
  const list = entries.filter(
    (entry): entry is string => typeof entry === "string",
  );
  const match = list.find(
    (entry) =>
      entry.startsWith(`${ref.registry}/${ref.repository}@`) ||
      entry.startsWith(`${ref.repository}@`),
  );
  const chosen = match ?? list[0];
  const at = chosen?.indexOf("@") ?? -1;
  return at >= 0 ? chosen!.slice(at + 1) : (ref.digest ?? null);
}

/** Bounded, redacted docker output plus an actionable hint for known failures. */
function failureMessage(
  prefix: string,
  result: ContainerExecResult,
  secrets: readonly string[],
  ref: ContainerImageRef,
  authenticated: boolean,
): string {
  const raw = `${result.stderr}\n${result.stdout}`;
  const lines = redactRegistrySecrets(raw, secrets)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_DIAGNOSTIC_LINES);
  const detail = lines.join("\n").slice(-MAX_DIAGNOSTIC_CHARS);
  const hint = actionableHint(detail, ref, authenticated);
  return `${prefix}: ${detail || `docker exited with code ${result.code}`}${hint ? `\n\n${hint}` : ""}`;
}

function actionableHint(
  detail: string,
  ref: ContainerImageRef,
  authenticated: boolean,
): string | null {
  if (
    /cannot connect to the docker daemon|permission denied.*docker\.sock/i.test(
      detail,
    )
  ) {
    return "The server cannot reach the Docker daemon — check that the service user is in the `docker` group and the socket is available.";
  }
  if (
    /unauthorized|authentication required|denied|forbidden|403|401/i.test(
      detail,
    )
  ) {
    if (ref.registry === GHCR_REGISTRY && authenticated) {
      return "The GitHub token authenticated but may not read this package. It needs the `read:packages` scope, and for SSO organizations it must be SSO-authorized for that org (Settings → GitHub).";
    }
    return `${ref.registry} rejected an anonymous pull; this image appears to be private.`;
  }
  if (/manifest unknown|not found|no such (image|manifest)/i.test(detail)) {
    return `Check the tag or digest — ${ref.normalized} does not exist in the registry.`;
  }
  return null;
}

/** Throttled, low-noise progress from `docker pull` stdout lines. */
function pullProgressReporter(
  ref: ContainerImageRef,
  onProgress: (message: string) => void,
): (line: string) => void {
  let lastAt = 0;
  let layers = 0;
  let latest = "";
  return (line) => {
    if (
      /pulling fs layer|downloading|extracting|download complete|pull complete|verifying checksum|waiting/i.test(
        line,
      )
    ) {
      if (/pull complete/i.test(line)) layers += 1;
      latest = line;
    } else {
      latest = line;
    }
    const now = Date.now();
    if (now - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = now;
    onProgress(
      `Pulling ${ref.normalized} — ${layers} layer(s) done · ${latest.slice(0, 120)}`,
    );
  };
}

let activePulls = 0;
const pullWaiters: Array<() => void> = [];

async function acquirePullSlot(): Promise<() => void> {
  if (activePulls >= MAX_CONCURRENT_PULLS) {
    await new Promise<void>((resolve) => pullWaiters.push(resolve));
  }
  activePulls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePulls -= 1;
    pullWaiters.shift()?.();
  };
}
