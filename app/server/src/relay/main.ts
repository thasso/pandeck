/**
 * The relay's command line (`relay.ts`), its own entry:
 *
 * - `enroll --state-dir <dir> --gateway <host:enrollPort> --ca <pem file>
 *   [--code-file <0600 file>]` (otherwise reads the code from stdin)
 * - `run --state-dir <dir> --port <loopback port> --socket <path>`
 *
 * It runs as Pandeck's server account, so agents can read neither its key
 * nor its socket, and outlives server restarts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { enrollRelay, startRelay } from "./relay.ts";
import { readEnrollmentCode } from "./enrollmentCode.ts";

function usage(): never {
  console.error(
    "usage: relay enroll --state-dir <dir> --gateway <host:port> --ca <pem file> [--code-file <0600 file>]\n       enrollment reads stdin unless --code-file is given\n       relay run --state-dir <dir> --port <port> --socket <path>",
  );
  process.exit(2);
}

function hostPort(value: string): { host: string; port: number } {
  const match = /^(.+):(\d{1,5})$/.exec(value);
  if (!match) usage();
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    "state-dir": { type: "string" },
    gateway: { type: "string" },
    ca: { type: "string" },
    "code-file": { type: "string" },
    port: { type: "string" },
    socket: { type: "string" },
  },
});
const stateDir = values["state-dir"];
if (!stateDir) usage();

if (command === "enroll") {
  if (!values.gateway || !values.ca) usage();
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
