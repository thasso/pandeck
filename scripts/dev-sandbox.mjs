/**
 * `pnpm dev:sandbox`: this checkout's dev server as a first run, with none of
 * your data. Server and Vite start from an empty environment (no tokens or
 * integration secrets from your shell) with their own DATA_DIR, HOME, XDG
 * directories and agent working directory under one sandbox folder, and listen
 * on loopback only. `--reset` wipes that folder for a fresh first run; it only
 * ever deletes a folder this script created.
 *
 *   pnpm dev:sandbox [--reset] [--dir <path>] [--port 8890] [--web-port 5190]
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MARKER = ".pandeck-sandbox";

/**
 * Throws unless `root` is absent, empty or marked as a sandbox: the only
 * folders this script may populate or `--reset` may delete.
 */
export function assertSandboxRoot(root) {
  if (!existsSync(root) || readdirSync(root).length === 0) return;
  if (!existsSync(join(root, MARKER)))
    throw new Error(
      `${root} is not empty and was not created by dev:sandbox; choose another --dir.`,
    );
}

/** The sandbox's complete environment: nothing is inherited but PATH. */
export function sandboxEnvironment(root, port, from = process.env) {
  const home = join(root, "home");
  return {
    PATH: from.PATH ?? "/usr/bin:/bin",
    TERM: from.TERM ?? "dumb",
    LANG: from.LANG ?? "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    DATA_DIR: join(root, "data"),
    ASSISTANT_CWD: join(root, "work"),
    ASSISTANT_HOST: "127.0.0.1",
    ASSISTANT_PORT: String(port),
    VITE_SERVER_PROXY: `http://127.0.0.1:${port}`,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      reset: { type: "boolean", default: false },
      port: { type: "string", default: "8890" },
      "web-port": { type: "string", default: "5190" },
    },
  });
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const root = resolve(values.dir ?? join(stateHome, "pandeck-sandbox"));
  assertSandboxRoot(root);
  if (values.reset) rmSync(root, { recursive: true, force: true });
  const env = sandboxEnvironment(root, values.port);
  for (const dir of [env.HOME, env.DATA_DIR, env.ASSISTANT_CWD])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, MARKER), "");

  // Node directly, not pnpm: under the sandbox HOME corepack would fetch pnpm.
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const webDir = join(repo, "app", "web");
  const vite = join(
    dirname(
      createRequire(join(webDir, "package.json")).resolve("vite/package.json"),
    ),
    "bin",
    "vite.js",
  );
  const children = [
    [
      "server",
      join(repo, "app", "server"),
      ["--import", "tsx", "src/dev-supervisor.ts"],
    ],
    [
      "web",
      webDir,
      [
        vite,
        "--host",
        "127.0.0.1",
        "--port",
        values["web-port"],
        "--strictPort",
      ],
    ],
  ].map(([name, cwd, args]) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        for (const line of String(chunk).split("\n"))
          if (line) process.stdout.write(`[${name}] ${line}\n`);
      });
    // Either one ending ends the sandbox; an unasked-for exit is a failure.
    child.on("exit", (code) => stop(stopping ? 0 : code || 1));
    return child;
  });

  let stopping = false;
  function stop(code) {
    if (stopping) return;
    stopping = true;
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
    process.exitCode = code;
  }
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  console.log(
    `Pandeck sandbox in ${root}\n` +
      `Open http://127.0.0.1:${values["web-port"]} (from another machine, forward that port).\n` +
      "Ctrl-C stops it; --reset starts the next run from scratch.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
