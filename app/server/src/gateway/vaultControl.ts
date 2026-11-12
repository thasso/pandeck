/**
 * The vault's local control socket (plan Task-1395): a Unix socket in the
 * service's runtime directory (`/run/pandeck-vault/control.sock`, 0600), one
 * JSON line in and one out per connection:
 *
 * - `{method: "unlock", pin}` → `{ok, opened, unopened}`, or `{wrong_pin,
 *   triesLeft}`, `{blocked}`, `{failed: code}`;
 * - `{method: "reseal"}` → `{ok, resealed}` or `{failed: code}`;
 * - `{method: "status"}` → `{locked}`.
 *
 * `adminMain.ts unlock` is its client. The PIN goes straight to the store and
 * is never logged or answered; a reply holds counts and fixed codes only.
 */
import { chmodSync, lstatSync, rmSync } from "node:fs";
import net from "node:net";
import type { SealedStore, UnlockAnswer } from "./sealedStore.ts";

const MAX_REQUEST_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_PIN_CHARS = 64;

export interface VaultControl {
  /** Stops listening and ends every open connection. */
  close(): Promise<void>;
}

export interface VaultControlHandlers {
  store: Pick<SealedStore, "locked" | "unlock" | "reseal">;
  /** Runs after a successful unlock: the vault rereads and renews. */
  unlocked(): void;
  log(line: string): void;
}

async function answer(
  request: Record<string, unknown>,
  handlers: VaultControlHandlers,
): Promise<Record<string, unknown>> {
  const { store, log } = handlers;
  if (request.method === "status") return { locked: store.locked() };
  if (request.method === "reseal") {
    try {
      return { ok: true, resealed: store.reseal() };
    } catch {
      log("control: reseal refused");
      return { failed: store.locked() ? "locked" : "reseal" };
    }
  }
  if (request.method === "unlock") {
    const { pin } = request;
    if (
      typeof pin !== "string" ||
      pin.length === 0 ||
      pin.length > MAX_PIN_CHARS
    )
      return { failed: "invalid" };
    let result: UnlockAnswer;
    try {
      result = await store.unlock(pin);
    } catch {
      result = { failed: "failed" };
    }
    if ("ok" in result) handlers.unlocked();
    else
      log(
        `control: unlock refused (${"wrong_pin" in result ? "wrong PIN" : "blocked" in result ? "blocked" : result.failed})`,
      );
    return result;
  }
  return { failed: "unknown_method" };
}

export async function startVaultControl(
  path: string,
  handlers: VaultControlHandlers,
): Promise<VaultControl> {
  // A stale socket from an earlier run; never any other file.
  try {
    if (lstatSync(path).isSocket()) rmSync(path);
  } catch {
    // None there.
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    let buffer = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (handled) return;
      buffer += chunk;
      const at = buffer.indexOf("\n");
      if (at < 0) {
        if (buffer.length > MAX_REQUEST_BYTES) socket.destroy();
        return;
      }
      handled = true;
      let request: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, at));
        if (typeof parsed === "object" && parsed !== null)
          request = parsed as Record<string, unknown>;
      } catch {
        // Answered as an unknown method.
      }
      buffer = "";
      void answer(request, handlers).then((reply) => {
        request = {};
        socket.end(`${JSON.stringify(reply)}\n`);
      });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  chmodSync(path, 0o600);
  handlers.log(`control socket at ${path}`);
  return {
    // An open connection, idle or not, does not hold a stop.
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/** One request to the control socket at `path`, and its answer. */
export function askVaultControl(
  path: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolveAnswer, reject) => {
    const socket = net.connect(path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
      socket.destroy(new Error("The vault did not answer.")),
    );
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        const parsed: unknown = JSON.parse(buffer);
        resolveAnswer(
          typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new Error("The vault's answer did not decode."));
      }
    });
  });
}
