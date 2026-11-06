/**
 * Tests' standalone gateway (`process.ts`) in a child process: what
 * `main.ts` runs, with the seams a test names in one JSON argument (fake
 * upstreams, a token endpoint that refuses, an injected Codex child) and no
 * real upstream. Prints `ready <port>` once control listens, and stops on
 * SIGTERM like the real entry. It lives here because only `gateway/` and the
 * server links import the gateway (`workerBoundary.test.ts`).
 */
import { codexChildPort, type CodexChildCommand } from "./codexChild.ts";
import type { GatewayOptions } from "./gateway.ts";
import { runGatewayProcess, stopOnSignals } from "./process.ts";

interface FixtureOptions {
  stateDir: string;
  port: number;
  socketPath: string;
  upstreams?: GatewayOptions["upstreams"];
  claudeTokenEndpoint: NonNullable<GatewayOptions["claudeTokenEndpoint"]>;
  codexCommand?: CodexChildCommand;
  drainMs?: number;
}

const options = JSON.parse(process.argv[2] ?? "{}") as FixtureOptions;
const log = (line: string): void => console.log(`[gateway] ${line}`);
const running = await runGatewayProcess({
  stateDir: options.stateDir,
  port: options.port,
  socketPath: options.socketPath,
  log,
  claudeTokenEndpoint: options.claudeTokenEndpoint,
  ...(options.upstreams ? { upstreams: options.upstreams } : {}),
  ...(options.codexCommand
    ? { renewCodex: codexChildPort(options.codexCommand) }
    : {}),
  ...(options.drainMs !== undefined ? { drainMs: options.drainMs } : {}),
});
stopOnSignals(running, log);
console.log(`ready ${running.gateway.port}`);
