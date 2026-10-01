import type { IncomingMessage, ServerResponse } from "node:http";

export type HeaderFactory = (req: IncomingMessage) => Record<string, string>;

export function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        fail(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown,
        );
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", fail);
  });
}

export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, headers(req));
  res.end(JSON.stringify(value));
}
