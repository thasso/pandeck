/**
 * The browser-facing read surface for one skill, dispatched from `index.ts`
 * under `/api/skills/*` and therefore behind the same token/origin gate as the
 * rest of `/api/` ([Task-614](pa://task/614), `docs/skills.md`).
 *
 * - `GET /api/skills/detail?name=<declared-name>` — compact metadata, bounded
 *   `SKILL.md` body, and bounded recursive supporting-file tree.
 * - `GET /api/skills/file?name=<declared-name>&path=<skill-relative-path>` —
 *   bounded raw bytes, or a bounded JSON text preview with `preview=text`.
 *
 * The library LIST stays on the `skills` topic: it is a subscription whose
 * answer is a rescan, and a second read surface for it would be a second thing
 * to keep in step. Only the body — too large for a list, wanted for exactly one
 * row at a time — is fetched here.
 *
 * `name` is the whole address. A caller cannot pass a path, and a name that
 * could never be declared is refused before any scan: the request is malformed
 * rather than unlucky, and saying so keeps 404 meaning "the library does not
 * have this skill".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSafeSkillName } from "@assistant/shared";
import { errorText } from "../errors.ts";
import { readSkillDetail } from "./skillDetail.ts";
import {
  InvalidSkillFilePathError,
  readSkillFilePreview,
  readSkillRawFile,
  SkillFileNotFoundError,
  SkillFileTooLargeError,
} from "./skillFiles.ts";

type Headers = Record<string, string>;

export async function handleSkillsApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  corsJsonHeaders: (req: IncomingMessage) => Headers,
): Promise<void> {
  const headers = corsJsonHeaders(req);
  const respond = (status: number, payload: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(payload));
  };

  if (req.method !== "GET") {
    respond(405, { error: "Method not allowed" });
    return;
  }

  try {
    switch (url.pathname) {
      case "/api/skills/detail": {
        const name = requiredSkillName(url, respond);
        if (!name) return;
        const detail = await readSkillDetail(name);
        if (!detail) {
          respond(404, { error: `No skill named "${name}" in the library.` });
          return;
        }
        respond(200, detail);
        return;
      }
      case "/api/skills/file": {
        const name = requiredSkillName(url, respond);
        if (!name) return;
        const path = url.searchParams.get("path") ?? "";
        if (!path) {
          respond(400, { error: "A skill-relative path is required." });
          return;
        }
        if (url.searchParams.get("preview") === "text") {
          const preview = await readSkillFilePreview(name, path);
          if (!preview) {
            respond(404, { error: `No readable skill named "${name}".` });
            return;
          }
          respond(200, preview);
          return;
        }
        const file = await readSkillRawFile(name, path);
        if (!file) {
          respond(404, { error: `No readable skill named "${name}".` });
          return;
        }
        res.writeHead(200, {
          ...headers,
          "content-type": file.mimeType,
          "content-length": String(file.bytes),
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(lastSegment(file.path))}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
        });
        res.end(file.content);
        return;
      }
      default:
        respond(404, { error: "Not found" });
    }
  } catch (err) {
    if (err instanceof InvalidSkillFilePathError) {
      respond(400, { error: err.message });
      return;
    }
    if (err instanceof SkillFileTooLargeError) {
      respond(413, { error: err.message });
      return;
    }
    if (err instanceof SkillFileNotFoundError) {
      respond(404, { error: err.message });
      return;
    }
    respond(500, { error: errorText(err) });
  }
}

function requiredSkillName(
  url: URL,
  respond: (status: number, payload: unknown) => void,
): string | null {
  const name = url.searchParams.get("name")?.trim() ?? "";
  if (!name) {
    respond(400, { error: "A skill name is required." });
    return null;
  }
  if (!isSafeSkillName(name)) {
    respond(400, { error: "Invalid skill name." });
    return null;
  }
  return name;
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
