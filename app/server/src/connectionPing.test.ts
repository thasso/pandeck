import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import { parseServerFrame } from "./test/serverFrames.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

const tmp = mkdtempSync(join(tmpdir(), "conn-ping-test-"));
process.env.ASSISTANT_CWD = tmp;

const { Connection } = await import("./connection.ts");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("a liveness ping is answered with exactly one pong", async () => {
  const validated = validateClientMessage({ type: "ping" });
  assert.ok(validated.ok);

  const sent: ServerMessage[] = [];
  const conn = new (
    Connection as unknown as new (ws: unknown) => {
      handle(msg: ClientMessage): Promise<void>;
    }
  )({
    OPEN: 1,
    readyState: 1,
    send: (frame: string | Buffer) => sent.push(parseServerFrame(frame)),
  });
  await conn.handle(validated.msg);
  assert.deepEqual(sent, [{ type: "pong" }]);
});
