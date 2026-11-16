/**
 * The relay's command line (`relay.ts`), its own entry:
 *
 * - `enroll --state-dir <dir> --gateway <host:enrollPort> --ca <pem file>
 *   [--code-file <0600 file>]` (otherwise reads the code from stdin)
 * - `enroll --approve --name <text> [--kind devbox|laptop|other]
 *   --state-dir <dir> --gateway <host:enrollPort> --ca <pem file>`: prints a
 *   link and a code to approve in the gateway page, then waits (Task-1410);
 *   Ctrl-C stops it and writes nothing
 * - `run --state-dir <dir> --port <loopback port> --socket <path>`
 *
 * It runs as Pandeck's server account, so agents can read neither its key
 * nor its socket, and outlives server restarts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  enrollRelay,
  enrollRelayByApproval,
  startRelay,
  type ApprovalPrompt,
  type MachineKind,
} from "./relay.ts";
import { readEnrollmentCode } from "./enrollmentCode.ts";

const KINDS: readonly string[] = ["devbox", "laptop", "other"];

function usage(): never {
  console.error(
    "usage: relay enroll --state-dir <dir> --gateway <host:port> --ca <pem file> [--code-file <0600 file>]\n       enrollment reads stdin unless --code-file is given\n       relay enroll --approve --name <text> [--kind devbox|laptop|other] --state-dir <dir> --gateway <host:port> --ca <pem file>\n       relay run --state-dir <dir> --port <port> --socket <path>",
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
      "To enroll this machine, open this link where you are signed in to the gateway:",
      `  ${prompt.verificationUri}`,
      `Check that the page shows the code ${prompt.userCode}, then approve.`,
      `The request expires in ${minutes} minutes. Waiting for approval…`,
    ].join("\n"),
  );
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    "state-dir": { type: "string" },
    gateway: { type: "string" },
    ca: { type: "string" },
    "code-file": { type: "string" },
    approve: { type: "boolean" },
    name: { type: "string" },
    kind: { type: "string" },
    port: { type: "string" },
    socket: { type: "string" },
  },
});
const stateDir = values["state-dir"];
if (!stateDir) usage();

if (command === "enroll" && values.approve) {
  if (!values.gateway || !values.ca || !values.name || values["code-file"])
    usage();
  if (values.kind !== undefined && !KINDS.includes(values.kind)) usage();
  const { host, port } = hostPort(values.gateway);
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
  if (!values.gateway || !values.ca || values.name || values.kind) usage();
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
  const relay = await startRelay({
    stateDir,
    port: Number(values.port),
    socketPath: values.socket,
  });
  const stop = (): void => {
    void relay.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
} else usage();
