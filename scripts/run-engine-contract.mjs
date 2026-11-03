#!/usr/bin/env node
/**
 * Runs the engine contract tests (C17.1, `docs/workers.md` "Engine-version
 * guard") inside a user, network and PID namespace with only loopback up, so
 * the real engine CLI can reach nothing but the test's own fakes.
 *
 * Only a failed capability probe counts as "no namespace": locally that is a
 * visible SKIP and exit 0, under `CI=true` a failure. Once the run starts, its
 * exit code stands, and a run that executed no test or skipped one fails.
 *
 * `PANDECK_UNSHARE` replaces the `unshare` command, for this script's tests.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = fileURLToPath(new URL("../app/server/", import.meta.url));
const CONTRACT_FILES = ["src/claudeSdk/engineContract.test.ts"];
const PROBE_TIMEOUT_MS = 10_000;
// The outer namespace maps root so it can bring loopback up; the run then
// enters a nested user namespace as the invoking uid and gid, keeping the
// network and PID namespaces, because the CLI refuses
// `--dangerously-skip-permissions` (the sessions' `bypassPermissions`) as root.
const NAMESPACE = [
  "--user",
  "--map-root-user",
  "--net",
  "--pid",
  "--fork",
  "--mount-proc",
  "--",
];
const AS_USER = `"$UNSHARE" --user --map-user=${process.getuid()} --map-group=${process.getgid()} --`;
const LOOPBACK_UP = "ip link set lo up";

/** `command` as found on PATH, or undefined. */
function onPath(command) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Why no namespace can be made here, or undefined when one can. */
function namespaceUnavailable(unshare) {
  if (!unshare) return "unshare not found";
  if (!onPath("ip")) return "ip not found";
  const probe = spawnSync(
    unshare,
    [...NAMESPACE, "sh", "-c", `${LOOPBACK_UP} && ${AS_USER} true`],
    {
      timeout: PROBE_TIMEOUT_MS,
      encoding: "utf8",
      env: { ...process.env, UNSHARE: unshare },
    },
  );
  if (probe.error)
    return probe.error.code === "ETIMEDOUT"
      ? `the probe timed out after ${PROBE_TIMEOUT_MS} ms`
      : `the probe failed: ${probe.error.message}`;
  if (probe.status !== 0) {
    const detail = probe.stderr.trim().split("\n").at(-1) ?? "";
    return `the probe exited ${probe.status ?? probe.signal}${detail ? `: ${detail}` : ""}`;
  }
  return undefined;
}

/** Why the JSON report is not a full run, or undefined when it is. */
function incompleteRun(report) {
  const results = (report.testResults ?? []).flatMap(
    (file) => file.assertionResults ?? [],
  );
  const executed = results.filter(
    (result) => result.status === "passed" || result.status === "failed",
  ).length;
  const skipped = results.length - executed;
  if (executed === 0) return "no contract test ran";
  if (skipped > 0) return `${skipped} contract tests did not run`;
  return undefined;
}

async function main() {
  const unshare = process.env.PANDECK_UNSHARE || onPath("unshare");
  const unavailable = namespaceUnavailable(unshare);
  if (unavailable) {
    if (process.env.CI === "true") {
      console.log(
        `engine-contract: FAIL: no network namespace: ${unavailable}`,
      );
      return 1;
    }
    console.log(
      `engine-contract: SKIP: no network namespace: ${unavailable} (CI runs it)`,
    );
    return 0;
  }

  const out = mkdtempSync(join(tmpdir(), "engine-contract-report-"));
  try {
    const report = join(out, "report.json");
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        unshare,
        [
          ...NAMESPACE,
          "sh",
          "-c",
          `${LOOPBACK_UP} && exec ${AS_USER} "$VITEST" run --reporter=default --reporter=json --outputFile="$OUT" ${CONTRACT_FILES.join(" ")}`,
        ],
        {
          cwd: SERVER_DIR,
          stdio: "inherit",
          env: {
            ...process.env,
            PANDECK_ENGINE_CONTRACT: "1",
            UNSHARE: unshare,
            VITEST: join(SERVER_DIR, "node_modules", ".bin", "vitest"),
            OUT: report,
          },
        },
      );
      child.on("error", reject);
      child.on("close", (status, signal) => resolve(status ?? signal));
    });
    if (code !== 0) {
      console.log(`engine-contract: FAIL: the contract run exited ${code}`);
      return typeof code === "number" ? code : 1;
    }
    let incomplete;
    try {
      incomplete = incompleteRun(JSON.parse(readFileSync(report, "utf8")));
    } catch (err) {
      incomplete = `no readable report: ${err.message}`;
    }
    if (incomplete) {
      console.log(`engine-contract: FAIL: ${incomplete}`);
      return 1;
    }
    console.log("engine-contract: PASS");
    return 0;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

process.exitCode = await main();
