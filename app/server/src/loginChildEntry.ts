/**
 * A login child's side of `gateway/loginChild.ts` (ADR-0005 "The login
 * children"): it runs one login driver in the directory named by the first
 * stdin line and relays the driver's events as JSON lines on stdout, never
 * the credential, which the driver leaves in that directory. Later lines are
 * the user's input, passed on and never logged. It ends with one
 * `{"type":"done","ok"}` line and exit 0.
 *
 * An invalid first line answers `ok: false` and starts no driver. SIGTERM, or
 * the end of stdin because the vault is gone, cancels the login; it still
 * answers once the driver has settled. Imports only `node:`, so each child
 * entry adds only its own driver.
 */
import { isAbsolute } from "node:path";

interface ChildLoginEvents {
  output(text: string): void;
  url(url: string): void;
  code(code: string): void;
}

type ChildLoginDriver = (
  configDir: string,
  events: ChildLoginEvents,
) => { input(text: string): void; cancel(): void; done: Promise<void> };

/** Output goes out in pieces well under the port's line bound. */
const OUTPUT_PIECE_CHARS = 2048;

function parse(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function runLoginChild(driver: ChildLoginDriver): void {
  let run: ReturnType<ChildLoginDriver> | undefined;
  let stopped = false;
  let finished = false;
  const send = (message: object): void => {
    if (!finished) process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const finish = (ok: boolean): void => {
    if (finished) return;
    finished = true;
    process.stdout.write(`${JSON.stringify({ type: "done", ok })}\n`, () =>
      process.exit(0),
    );
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (run) run.cancel();
    else finish(false);
  };
  const events: ChildLoginEvents = {
    output(text) {
      for (let at = 0; at < text.length; at += OUTPUT_PIECE_CHARS)
        send({ type: "output", text: text.slice(at, at + OUTPUT_PIECE_CHARS) });
    },
    url: (url) => send({ type: "url", text: url }),
    code: (code) => send({ type: "code", text: code }),
  };
  const onLine = (line: string): void => {
    const message = parse(line);
    if (run) {
      if (typeof message?.input === "string") run.input(message.input);
      return;
    }
    if (finished) return;
    const configDir = message?.configDir;
    if (typeof configDir !== "string" || !isAbsolute(configDir)) {
      finish(false);
      return;
    }
    try {
      run = driver(configDir, events);
    } catch {
      finish(false);
      return;
    }
    run.done.then(
      () => finish(!stopped),
      () => finish(false),
    );
  };

  process.on("SIGTERM", stop);
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at !== -1;) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      onLine(line);
      at = buffered.indexOf("\n");
    }
  });
  process.stdin.once("end", stop);
}
