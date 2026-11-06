import assert from "node:assert/strict";
import { Agent, request } from "node:https";
import { afterAll, test } from "vitest";
import { startFakeUpstreams } from "./gatewayFixtures.ts";

const upstreamsPromise = startFakeUpstreams();
afterAll(async () => {
  const upstreams = await upstreamsPromise;
  await upstreams.close();
});

test("reset clears observations without closing keep-alive connections", async () => {
  const upstreams = await upstreamsPromise;
  const agent = new Agent({ keepAlive: true, ca: upstreams.tokenEndpoint.ca });
  const send = () =>
    new Promise<{
      status: number;
      socket: NodeJS.ReadableStream & { destroyed: boolean };
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: upstreams.tokenEndpoint.connect.host,
          port: upstreams.tokenEndpoint.connect.port,
          path: "/oauth/token",
          method: "POST",
          servername: "platform.claude.com",
          agent,
        },
        (res) => {
          const socket = res.socket;
          res.resume();
          res.once("end", () =>
            resolve({ status: res.statusCode ?? 0, socket }),
          );
        },
      );
      req.once("error", reject);
      req.end();
    });

  try {
    const first = await send();
    assert.equal(first.status, 200);
    assert.equal(upstreams.platform.length, 1);

    upstreams.reset();
    assert.equal(upstreams.platform.length, 0, "request observations cleared");
    assert.equal(
      first.socket.destroyed,
      false,
      "keep-alive socket remains open",
    );

    const second = await send();
    assert.equal(second.status, 200);
    assert.equal(second.socket, first.socket, "the existing socket was reused");
    assert.equal(
      upstreams.platform.length,
      1,
      "only the post-reset request remains",
    );
  } finally {
    agent.destroy();
  }
});
