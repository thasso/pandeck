import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebPushSubscriptionInput } from "@assistant/shared";
import {
  readJsonBody,
  sendJson as json,
  type HeaderFactory,
} from "./httpJson.ts";
import { getWebPushConfig } from "./webPush.ts";
import {
  removeWebPushSubscription,
  upsertWebPushSubscription,
} from "./webPushStore.ts";

const MAX_BODY_BYTES = 16_384;

/** Authenticated HTTP surface for one installation's Declarative Web Push subscription. */
export async function handleWebPushApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  headers: HeaderFactory,
  requestOrigin: string | undefined,
): Promise<void> {
  if (url.pathname === "/api/web-push/config") {
    if (req.method !== "GET") {
      json(req, res, headers, 405, { error: "Method not allowed" });
      return;
    }
    try {
      json(req, res, headers, 200, getWebPushConfig());
    } catch (error) {
      json(req, res, headers, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname !== "/api/web-push/subscription") {
    json(req, res, headers, 404, { error: "Not found" });
    return;
  }

  if (req.method !== "POST" && req.method !== "DELETE") {
    json(req, res, headers, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Request body must be an object.");
    if (req.method === "POST") {
      if (!requestOrigin)
        throw new Error("Could not determine this app installation's origin.");
      upsertWebPushSubscription(
        body as WebPushSubscriptionInput,
        requestOrigin,
      );
      json(req, res, headers, 200, { ok: true });
      return;
    }
    const endpoint = (body as { endpoint?: unknown }).endpoint;
    const removed = removeWebPushSubscription(endpoint);
    json(req, res, headers, 200, { ok: true, removed });
  } catch (error) {
    json(req, res, headers, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
