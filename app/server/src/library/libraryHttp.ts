/**
 * The browser-facing read surface for one library entry, dispatched from
 * `index.ts` under `/api/<library>/*` (`/api/skills/*`, `/api/agents/*`) and
 * therefore behind the same token/origin gate as the rest of `/api/`
 * ([Task-614](pa://task/614), `docs/skills.md`, `docs/agent-definitions.md`).
 *
 * - `GET /api/<library>/detail?name=<declared-name>` — compact metadata,
 *   bounded manifest body, and bounded recursive supporting-file tree.
 * - `GET /api/<library>/file?name=<declared-name>&path=<entry-relative-path>` —
 *   bounded raw bytes, or a bounded JSON text preview with `preview=text`.
 * - `GET /api/<library>/history?name=<declared-name>` — the entry folder's
 *   recent commits, newest first.
 *
 * The library LIST stays on the library's topic: it is a subscription whose
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
import { dirname } from "node:path";
import { isSafeEntryName, type EntryHistory } from "@assistant/shared";
import { errorText } from "../errors.ts";
import { readEntryDetail } from "./entryDetail.ts";
import {
  InvalidEntryFilePathError,
  readEntryFilePreview,
  readEntryRawFile,
  EntryFileNotFoundError,
  EntryFileTooLargeError,
} from "./entryFiles.ts";
import { scanLibrary } from "./libraryScanner.ts";
import type { LibraryStore } from "./libraryStore.ts";

type Headers = Record<string, string>;

/** How many commits one history read returns. */
const ENTRY_HISTORY_LIMIT = 20;

export async function handleLibraryApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  corsJsonHeaders: (req: IncomingMessage) => Headers,
  library: LibraryStore,
): Promise<void> {
  const { noun, plural } = library.kind;
  const prefix = `/api/${plural}`;
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
      case `${prefix}/detail`: {
        const name = requiredEntryName(url, noun, respond);
        if (!name) return;
        const detail = await readEntryDetail(name, library);
        if (!detail) {
          respond(404, { error: `No ${noun} named "${name}" in the library.` });
          return;
        }
        respond(200, detail);
        return;
      }
      case `${prefix}/history`: {
        const name = requiredEntryName(url, noun, respond);
        if (!name) return;
        await library.ensureInitialized();
        const scan = await scanLibrary(library.kind, library.root);
        const entry = scan.entries.find((candidate) => candidate.name === name);
        if (!entry) {
          respond(404, { error: `No ${noun} named "${name}" in the library.` });
          return;
        }
        const history = await library.history({
          path: dirname(entry.path),
          limit: ENTRY_HISTORY_LIMIT,
        });
        const answer: EntryHistory = {
          commits: history.entries.map((commit) => ({
            shortCommit: commit.shortCommit,
            author: commit.author,
            date: commit.date,
            subject: commit.subject,
          })),
          truncated: history.truncated,
        };
        respond(200, answer);
        return;
      }
      case `${prefix}/file`: {
        const name = requiredEntryName(url, noun, respond);
        if (!name) return;
        const path = url.searchParams.get("path") ?? "";
        if (!path) {
          respond(400, { error: `A ${noun}-relative path is required.` });
          return;
        }
        if (url.searchParams.get("preview") === "text") {
          const preview = await readEntryFilePreview(name, path, library);
          if (!preview) {
            respond(404, { error: `No readable ${noun} named "${name}".` });
            return;
          }
          respond(200, preview);
          return;
        }
        const file = await readEntryRawFile(name, path, library);
        if (!file) {
          respond(404, { error: `No readable ${noun} named "${name}".` });
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
    if (err instanceof InvalidEntryFilePathError) {
      respond(400, { error: err.message });
      return;
    }
    if (err instanceof EntryFileTooLargeError) {
      respond(413, { error: err.message });
      return;
    }
    if (err instanceof EntryFileNotFoundError) {
      respond(404, { error: err.message });
      return;
    }
    respond(500, { error: errorText(err) });
  }
}

function requiredEntryName(
  url: URL,
  noun: string,
  respond: (status: number, payload: unknown) => void,
): string | null {
  const name = url.searchParams.get("name")?.trim() ?? "";
  if (!name) {
    respond(400, { error: `A ${noun} name is required.` });
    return null;
  }
  if (!isSafeEntryName(name)) {
    respond(400, { error: `Invalid ${noun} name.` });
    return null;
  }
  return name;
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
