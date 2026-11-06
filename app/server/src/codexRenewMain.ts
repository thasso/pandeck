/**
 * The Codex renewal child (ADR-0005, M5), its own entry: the standalone
 * gateway spawns one per renewal through `gateway/codexChild.ts`. It reads one
 * line, `{authFile, minValidityMs}`, renews that one file with pi's refresh
 * (`piSdk/codexRenewal.ts`, via the harness gateway port), prints one result line,
 * never a token, and exits 0. SIGTERM aborts the refresh; stdin's end does
 * not, so a piped single line works.
 */
import { renewCodexCredential } from "./harnesses/gatewayPorts.ts";

const abort = new AbortController();
process.once("SIGTERM", () => abort.abort());

function answer(result: object): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    const done = (): void => {
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      resolve(input.split("\n", 1)[0] ?? "");
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.includes("\n")) done();
    });
    process.stdin.once("end", done);
  });
}

function parseRequest(
  line: string,
): { authFile: string; minValidityMs: number } | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown> | null;
    if (
      typeof value?.authFile === "string" &&
      value.authFile !== "" &&
      typeof value.minValidityMs === "number" &&
      Number.isFinite(value.minValidityMs)
    )
      return { authFile: value.authFile, minValidityMs: value.minValidityMs };
  } catch {
    // Not JSON.
  }
  return undefined;
}

const request = parseRequest(await readLine());
if (!request) answer({ ok: false, kind: "failed", code: "input" });
else
  answer(
    await renewCodexCredential(
      request.authFile,
      request.minValidityMs,
      abort.signal,
    ),
  );
