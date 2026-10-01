/**
 * Authenticated HTTP surface for one iOS installation's APNs registration.
 *
 * The counterpart to `webPushHttp.ts`, and the same two operations: ask whether
 * this server can push at all, and hand it (or take back) this installation's
 * token. Both sit behind the same token/origin gate as the rest of `/api`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApnsConfigResponse } from "@assistant/shared";
import {
  readJsonBody,
  sendJson as json,
  type HeaderFactory,
} from "./httpJson.ts";
import { sendApnsNotification } from "./apns.ts";
import {
  getApnsCredential,
  listApnsDevices,
  removeApnsDevice,
  upsertApnsDevice,
} from "./apnsStore.ts";

const MAX_BODY_BYTES = 4_096;

/** Public shape of this server's push capability. Never the key itself. */
function getApnsConfig(): ApnsConfigResponse {
  const credential = getApnsCredential();
  return {
    configured: credential !== null,
    ...(credential ? { bundleId: credential.bundleId } : {}),
    deviceCount: listApnsDevices().length,
  };
}

export async function handleApnsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  headers: HeaderFactory,
): Promise<void> {
  if (url.pathname === "/api/apns/config") {
    if (req.method !== "GET") {
      json(req, res, headers, 405, { error: "Method not allowed" });
      return;
    }
    json(req, res, headers, 200, getApnsConfig());
    return;
  }

  // The one route the device cannot check for itself. A rejected push is silent
  // from the phone's side — Apple tells the SERVER and nobody else — so proving
  // the whole chain means sending a real one and reporting what Apple said.
  if (url.pathname === "/api/apns/test") {
    if (req.method !== "POST") {
      json(req, res, headers, 405, { error: "Method not allowed" });
      return;
    }
    const report = await sendApnsNotification({
      title: "Pandeck",
      body: "Apple push is working.",
      navigatePath: "/",
    });
    json(req, res, headers, 200, report);
    return;
  }

  if (url.pathname !== "/api/apns/device") {
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
    const record = body as Record<string, unknown>;
    if (req.method === "POST") {
      upsertApnsDevice({
        token: record.token,
        environment: record.environment,
        installId: record.installId,
        label: record.label,
      });
      json(req, res, headers, 200, { ok: true });
      return;
    }
    const removed = removeApnsDevice(record.token);
    json(req, res, headers, 200, { ok: true, removed });
  } catch (error) {
    json(req, res, headers, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
