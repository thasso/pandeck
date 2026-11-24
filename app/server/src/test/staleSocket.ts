/** A real stale socket, not a regular file that a safe listener must preserve. */
import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";

export async function leaveStaleUnixSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import net from 'node:net'; const server = net.createServer(); server.on('error', error => { console.error(error.message); process.exit(1); }); server.listen(process.argv[1], () => console.log('ready'));`,
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`stale socket fixture did not bind: ${stderr}`)),
        10_000,
      );
      timer.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (String(chunk).includes("ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error(`stale socket fixture exited: ${stderr}`));
      });
    });
  } finally {
    // This PID belongs only to the fixture we just created, never an app process.
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  }
  if (!lstatSync(path).isSocket())
    throw new Error(`Expected a real stale socket at ${path}`);
}
