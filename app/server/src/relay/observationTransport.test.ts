/** Bounded response handling for the relay's private observation exchange. */
import assert from "node:assert/strict";
import https from "node:https";
import { afterEach, test } from "vitest";
import { edgeTlsFor } from "../gateway/x509.ts";
import { observationTransport } from "./observationTransport.ts";

const servers: https.Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

test("oversized malformed answer cannot acknowledge a valid retained prefix", async () => {
  const tls = edgeTlsFor(["127.0.0.1"], undefined);
  const server = https.createServer(
    { key: tls.serverKeyPem, cert: tls.serverCertPem },
    (_req, res) => {
      res.writeHead(200);
      res.write('{"ack":1}');
      setTimeout(() => res.end("INVALID".repeat(1200)), 20);
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const send = observationTransport(
    { host: "127.0.0.1", port, ca: tls.caCertPem, agent: false },
    500,
  );
  await assert.rejects(
    send(
      { boot: "b".repeat(32), records: [{ d: 1, note: "relay-restarted" }] },
      new AbortController().signal,
    ),
    /Observation answer too large/,
  );
});
