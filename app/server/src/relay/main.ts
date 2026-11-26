/**
 * The relay's command line (`relay.ts`), its own entry:
 *
 * - `enroll --state-dir <dir> --gateway <host:enrollPort> --ca <pem file>
 *   [--code-file <0600 file>]` (otherwise reads the code from stdin)
 * - `enroll --approve --name <text> [--kind devbox|laptop|other]
 *   --state-dir <dir> --gateway <host:enrollPort> --ca <pem file>`: prints a
 *   link and a code to approve in the gateway page, then waits (Task-1410);
 *   Ctrl-C stops it and writes nothing. With `--owner-token-file <0600 file
 *   | ->` (`-` is stdin) a devbox sends its owner's Google access token as
 *   proof and, when the gateway approves at once, prints "Approved
 *   automatically." instead of the link (Task-1410 PR2); an empty token
 *   means the link
 * - `run --state-dir <dir> --port <loopback port> --socket <path>
 *   [--intercept-ca-cert <path>]`: with the flag, loads or makes the
 *   interception CA in the state directory, writes its certificate (never the
 *   key) to the path for `NODE_EXTRA_CA_CERTS`, and decrypts the named hosts
 *   (ADR-0006)
 * - `git-credential --socket <path> <operation>` (Task-1446): git's
 *   credential helper for `https://github.com` through `run`'s socket
 *   (`gitCredential.ts`). `get` prints a read installation token for one
 *   repository, or `quit=1`; every other operation prints nothing. It needs
 *   no `--state-dir`, always exits 0, and writes no file and no log.
 *
 * It runs as Pandeck's server account, so agents cannot read its key, and
 * outlives server restarts. Whoever can open the 0600 socket, Pandeck's
 * account and the agents that share it (M17), can use the client
 * connection, including asking for read git tokens; that is the intended
 * capability.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { gitCredentialMain } from "./gitCredential.ts";
import {
  enrollRelay,
  enrollRelayByApproval,
  startRelay,
  type ApprovalPrompt,
  type MachineKind,
} from "./relay.ts";
import { readEnrollmentCode, readOwnerToken } from "./enrollmentCode.ts";
import {
  loadInterceptCa,
  writeCaCertificate,
  type InterceptCa,
} from "./interceptCa.ts";

const KINDS: readonly string[] = ["devbox", "laptop", "other"];

function usage(): never {
  console.error(
    "usage: relay enroll --state-dir <dir> --gateway <host:port> --ca <pem file> [--code-file <0600 file>]\n       enrollment reads stdin unless --code-file is given\n       relay enroll --approve --name <text> [--kind devbox|laptop|other] [--owner-token-file <0600 file | ->] --state-dir <dir> --gateway <host:port> --ca <pem file>\n       relay run --state-dir <dir> --port <port> --socket <path> [--intercept-ca-cert <path>]\n       relay git-credential --socket <path> <operation>",
  );
  process.exit(2);
}

function hostPort(value: string): { host: string; port: number } {
  const match = /^(.+):(\d{1,5})$/.exec(value);
  if (!match) usage();
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

/** The link and code, for the person at this machine; nothing secret. */
function showPrompt(prompt: ApprovalPrompt): void {
  const minutes = Math.round(prompt.expiresInSeconds / 60);
  console.log(
    [
      ...(prompt.automaticRefused
        ? [
            `Automatic approval declined (${prompt.automaticRefused}); approve in the browser instead.`,
          ]
        : []),
      "To enroll this machine, open this link where you are signed in to the gateway:",
      `  ${prompt.verificationUri}`,
      `Check that the page shows the code ${prompt.userCode}, then approve.`,
      `The request expires in ${minutes} minutes. Waiting for approval…`,
    ].join("\n"),
  );
}

const [command, ...rest] = process.argv.slice(2);
// Before the shared options and `--state-dir`: its own command line. It sets
// the exit code and returns, so stdout drains before the process ends.
if (command === "git-credential")
  process.exitCode = await gitCredentialMain(rest, process);
else await main();

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      "state-dir": { type: "string" },
      gateway: { type: "string" },
      ca: { type: "string" },
      "code-file": { type: "string" },
      "owner-token-file": { type: "string" },
      approve: { type: "boolean" },
      name: { type: "string" },
      kind: { type: "string" },
      port: { type: "string" },
      socket: { type: "string" },
      "intercept-ca-cert": { type: "string" },
    },
  });
  const stateDir = values["state-dir"];
  if (!stateDir) usage();

  if (command === "enroll" && values.approve) {
    if (!values.gateway || !values.ca || !values.name || values["code-file"])
      usage();
    if (values.kind !== undefined && !KINDS.includes(values.kind)) usage();
    const { host, port } = hostPort(values.gateway);
    const ownerTokenFile = values["owner-token-file"];
    let googleAccessToken: string | undefined;
    try {
      googleAccessToken =
        ownerTokenFile === undefined
          ? undefined
          : readOwnerToken(ownerTokenFile);
    } catch (err) {
      // Our own refusal, or the open's (a symlink, a missing file): no content.
      console.error(err instanceof Error ? err.message : "Unreadable token.");
      process.exit(1);
    }
    const stop = new AbortController();
    process.once("SIGINT", () => stop.abort());
    process.once("SIGTERM", () => stop.abort());
    try {
      const clientId = await enrollRelayByApproval({
        stateDir,
        host,
        enrollPort: port,
        caPem: readFileSync(values.ca, "utf8"),
        name: values.name,
        ...(values.kind ? { kind: values.kind as MachineKind } : {}),
        onPrompt: showPrompt,
        ...(googleAccessToken ? { devbox: { googleAccessToken } } : {}),
        onAutomatic: () => console.log("Approved automatically."),
        signal: stop.signal,
      });
      console.log(`enrolled as client ${clientId}`);
      process.exit(0);
    } catch (err) {
      if (stop.signal.aborted) {
        console.error("Enrollment stopped; nothing was written.");
        process.exit(130);
      }
      console.error(err instanceof Error ? err.message : "Enrollment failed.");
      process.exit(1);
    }
  } else if (command === "enroll") {
    if (
      !values.gateway ||
      !values.ca ||
      values.name ||
      values.kind ||
      values["owner-token-file"]
    )
      usage();
    const { host, port } = hostPort(values.gateway);
    const clientId = await enrollRelay({
      stateDir,
      host,
      enrollPort: port,
      caPem: readFileSync(values.ca, "utf8"),
      code: readEnrollmentCode(values["code-file"]),
    });
    console.log(`enrolled as client ${clientId}`);
  } else if (command === "run") {
    if (!values.port || !values.socket) usage();
    const caCertPath = values["intercept-ca-cert"];
    let interceptCa: InterceptCa | undefined;
    if (caCertPath !== undefined) {
      try {
        interceptCa = loadInterceptCa(stateDir);
      } catch (err) {
        // `loadInterceptCa`'s fixed message names the file, never a key.
        console.error(
          err instanceof Error ? err.message : "Unusable interception CA.",
        );
        process.exit(1);
      }
      try {
        writeCaCertificate(interceptCa, caCertPath);
      } catch {
        console.error(
          `Cannot write the interception CA certificate to ${caCertPath}.`,
        );
        process.exit(1);
      }
      console.log(`[relay] interception CA certificate at ${caCertPath}`);
    }
    const relay = await startRelay({
      stateDir,
      port: Number(values.port),
      socketPath: values.socket,
      ...(interceptCa ? { interceptCa } : {}),
    });
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void relay.close().then(() => process.exit(0));
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } else usage();
}
