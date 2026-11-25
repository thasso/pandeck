/**
 * A local multipart peer in its own process (Task-1441 P8a, v04 V2): the
 * 100 MiB upload test measures the sender's live memory, which must not
 * include the peer's socket and parse buffers. Prints `ready <port>`, then one
 * `upload <json>` line per body with its framing and the file part's digest.
 * Loopback only; every value is fake.
 */
import { MultipartSink, uploadPeer } from "./multipartSink.ts";

const peer = await uploadPeer((request, response) => {
  const sink = new MultipartSink(request.headers["content-type"] ?? "");
  const length = request.headers["content-length"];
  const chunked = /chunked/i.test(request.headers["transfer-encoding"] ?? "");
  request.on("data", (chunk: Buffer) => sink.push(chunk));
  request.on("end", () => {
    const digest = sink.finish();
    console.log(
      `upload ${JSON.stringify({
        length,
        chunked,
        digest,
        closed: sink.closed,
        received: sink.received,
      })}`,
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ results: [{ id: "att9" }] }));
  });
});
console.log(`ready ${new URL(peer.base).port}`);
process.on("SIGTERM", () => {
  void peer.close().then(() => process.exit(0));
});
