/**
 * HTTP surface of the session status card (`docs/session-status.md`):
 * GET `/api/session-status?sessionId=…` reads the last card, POST
 * `/api/session-status/refresh` writes a new one and answers with it. Auth and
 * CORS are applied centrally in `index.ts` before this handler runs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  SessionStatusRefreshRequest,
  SessionStatusResponse,
} from "@assistant/shared";
import { errorText } from "../errors.ts";
import { NoHelperModelError } from "../harnesses/oneShot.ts";
import {
  readJsonBody,
  sendJson as json,
  type HeaderFactory,
} from "../httpJson.ts";
import {
  cleanSessionId,
  SessionInspectionError,
} from "../tools/sessions/sessionInspection.ts";
import {
  joinSessionStatus,
  readSessionStatus,
  refreshSessionStatus,
  SessionStatusUnavailableError,
} from "./statusAgent.ts";

const MAX_BODY_BYTES = 4 * 1024;

export async function handleSessionStatusApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  headers: HeaderFactory,
): Promise<void> {
  if (url.pathname === "/api/session-status") {
    if (req.method !== "GET") {
      json(req, res, headers, 405, { error: "Method not allowed" });
      return;
    }
    answer(req, res, headers, () =>
      readSessionStatus(cleanSessionId(url.searchParams.get("sessionId"))),
    );
    return;
  }
  if (url.pathname === "/api/session-status/refresh") {
    if (req.method !== "POST") {
      json(req, res, headers, 405, { error: "Method not allowed" });
      return;
    }
    let sessionId: string;
    let joinOnly: boolean;
    try {
      const body = (await readJsonBody(
        req,
        MAX_BODY_BYTES,
      )) as Partial<SessionStatusRefreshRequest>;
      sessionId = cleanSessionId(body.sessionId);
      joinOnly = body.joinOnly === true;
    } catch (err) {
      json(req, res, headers, 400, { error: errorText(err) });
      return;
    }
    try {
      const response: SessionStatusResponse = joinOnly
        ? await joinSessionStatus(sessionId)
        : { card: await refreshSessionStatus(sessionId), refreshing: false };
      json(req, res, headers, 200, response);
    } catch (err) {
      json(req, res, headers, statusFor(err), { error: errorText(err) });
    }
    return;
  }
  json(req, res, headers, 404, { error: "Not found" });
}

function answer(
  req: IncomingMessage,
  res: ServerResponse,
  headers: HeaderFactory,
  read: () => SessionStatusResponse,
): void {
  try {
    json(req, res, headers, 200, read());
  } catch (err) {
    json(req, res, headers, statusFor(err), { error: errorText(err) });
  }
}

function statusFor(err: unknown): number {
  if (err instanceof SessionStatusUnavailableError) return 404;
  if (err instanceof SessionInspectionError) return 400;
  // The configured model is not offered by its account: a setting to fix.
  if (err instanceof NoHelperModelError) return 409;
  return 500;
}
