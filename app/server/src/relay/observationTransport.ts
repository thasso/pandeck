/** The relay's own small JSON exchange, never a forwarded request body. */
import https from "node:https";
import type { ObservationAnswer, ObservationBatch } from "./observations.ts";

export function observationTransport(
  options: https.RequestOptions,
  timeoutMs: number,
) {
  return (
    batch: ObservationBatch,
    signal: AbortSignal,
  ): Promise<ObservationAnswer> =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify(batch);
      const request = https.request({
        ...options,
        method: "POST",
        path: "/relay/observations",
        signal,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      });
      const deadline = setTimeout(
        () => request.destroy(new Error("Observation deadline.")),
        timeoutMs,
      );
      request.on("error", reject);
      request.on("close", () => clearTimeout(deadline));
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) {
            response.destroy();
            request.destroy(new Error("Observation answer too large."));
          } else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          let ack: number | undefined;
          try {
            const parsed: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              "ack" in parsed &&
              typeof parsed.ack === "number"
            )
              ack = parsed.ack;
          } catch {
            // A malformed success is retried, not an acknowledgement.
          }
          resolve({
            status: response.statusCode ?? 0,
            ...(ack === undefined ? {} : { ack }),
          });
        });
        response.on("close", () => {
          if (!response.complete)
            reject(new Error("Incomplete observation answer."));
        });
      });
      request.end(body);
    });
}
