/**
 * HTTP surface for worktrees, dispatched from `index.ts` under
 * `/api/worktrees/:id/<verb>`. Heavy read payloads (file contents, diffs,
 * trees, logs) go over HTTP GET like the calendar/workspace surfaces; light
 * state and broadcasts stay on the WebSocket. User-initiated commit,
 * auto-commit, clean, push, synchronization, create-PR and merge-PR writes are
 * HTTP POSTs (the caller needs the direct result). Auth/CORS are applied
 * centrally in `index.ts` before this handler runs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  WorktreeAutoCommitRequest,
  WorktreeCommitRequest,
  WorktreeCreatePrRequest,
  WorktreeDiffScope,
  WorktreeHostingListResponse,
  WorktreeMergePrRequest,
  WorktreePushRequest,
  WorktreeRetireRequest,
} from "@assistant/shared";
import { errorText } from "../errors.ts";
import type { WorktreeRow } from "../db/worktreeStore.ts";
import { listWorktreeRows } from "./worktrees.ts";
import { resolveWorktreeRow } from "./worktreeResolve.ts";
import { computeWorktreeStatus } from "./worktreeStatus.ts";
import {
  getWorktreeChanges,
  getWorktreeFileContent,
  getWorktreeFileDiff,
  getWorktreeFileRaw,
  getWorktreeLog,
  getWorktreeTree,
  isSafeRef,
} from "./worktreeDiff.ts";
import {
  autoCommitWorktree,
  cleanWorktree,
  commitWorktree,
  pushWorktree,
} from "./worktreeWrite.ts";
import {
  createWorktreePullRequest,
  worktreeHostingStatus,
  worktreeHostingStatuses,
} from "./worktreeHosting.ts";
import { syncWorktree } from "./worktreeSync.ts";
import { mergeWorktreePullRequest } from "../pullRequestMerge.ts";
import { retireWorktree } from "../worktreeRemoval.ts";

type Headers = Record<string, string>;

const POST_VERBS = new Set([
  "commit",
  "auto-commit",
  "clean",
  "push",
  "pull-rebase",
  "rebase-main",
  "fast-forward-main",
  "create-pr",
  "merge-pr",
  "retire",
]);
const MAX_BODY_BYTES = 256 * 1024;

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Invalid request body: too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch {
        reject(new Error("Invalid request body."));
      }
    });
    req.on("error", reject);
  });
}

export async function handleWorktreeApi(
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

  // Collection-level read: hosting for EVERY active worktree in one request,
  // for the Worktrees inbox. It carries no id, so it is dispatched before the
  // `/:id/<verb>` pattern below (which would otherwise never match it anyway).
  if (url.pathname === "/api/worktrees/hosting") {
    if (req.method !== "GET") {
      respond(405, { error: "Method not allowed" });
      return;
    }
    try {
      const statuses = await worktreeHostingStatuses(await listWorktreeRows());
      respond(200, {
        statuses,
        fetchedAt: Date.now(),
      } satisfies WorktreeHostingListResponse);
    } catch (err) {
      respond(500, { error: errorText(err) });
    }
    return;
  }

  // The id may be a spawned worktree uuid or a synthetic `main:<projectId>`
  // (percent-encoded by the client); decode then resolve through the seam.
  const match = url.pathname.match(
    /^\/api\/worktrees\/([^/]{1,128})\/([a-z-]+)$/,
  );
  if (!match) {
    respond(404, { error: "Not found" });
    return;
  }
  const [, encodedId, verb] = match;

  const expectedMethod = POST_VERBS.has(verb!) ? "POST" : "GET";
  if (req.method !== expectedMethod) {
    respond(405, { error: "Method not allowed" });
    return;
  }

  let worktreeId: string;
  try {
    worktreeId = decodeURIComponent(encodedId!); // malformed %-encoding → 400, not a crash
  } catch {
    respond(400, { error: "Invalid worktree id" });
    return;
  }

  try {
    const row = await resolveWorktreeRow(worktreeId);
    if (!row) {
      respond(404, { error: "Unknown worktree" });
      return;
    }
    if (verb === "commit") {
      const body = await readJsonBody<WorktreeCommitRequest>(req);
      respond(
        200,
        await commitWorktree(row, {
          message: typeof body.message === "string" ? body.message : "",
          ...(Array.isArray(body.paths) ? { paths: body.paths } : {}),
        }),
      );
      return;
    }
    if (verb === "auto-commit") {
      const body = await readJsonBody<WorktreeAutoCommitRequest>(req);
      respond(
        200,
        await autoCommitWorktree(row, { force: body.force === true }),
      );
      return;
    }
    if (verb === "clean") {
      await readJsonBody<Record<string, never>>(req);
      respond(200, await cleanWorktree(row));
      return;
    }
    if (verb === "push") {
      const body = await readJsonBody<WorktreePushRequest>(req);
      respond(200, await pushWorktree(row, { force: body.force === true }));
      return;
    }
    if (
      verb === "pull-rebase" ||
      verb === "rebase-main" ||
      verb === "fast-forward-main"
    ) {
      await readJsonBody<Record<string, never>>(req);
      respond(200, await syncWorktree(row, verb));
      return;
    }
    if (verb === "create-pr") {
      const body = await readJsonBody<WorktreeCreatePrRequest>(req);
      respond(
        200,
        await createWorktreePullRequest(row, {
          title: typeof body.title === "string" ? body.title : "",
          ...(typeof body.body === "string" ? { body: body.body } : {}),
        }),
      );
      return;
    }
    if (verb === "retire") {
      const body = await readJsonBody<WorktreeRetireRequest>(req);
      if (
        (body.deleteBranch !== undefined &&
          typeof body.deleteBranch !== "boolean") ||
        (body.force !== undefined && typeof body.force !== "boolean")
      ) {
        respond(400, {
          error: "Invalid retire options: expected boolean values.",
        });
        return;
      }
      respond(
        200,
        await retireWorktree(row.id, {
          deleteBranch: body.deleteBranch !== false,
          force: body.force === true,
        }),
      );
      return;
    }
    if (verb === "merge-pr") {
      const body = await readJsonBody<WorktreeMergePrRequest>(req);
      // The method is never defaulted: merging with a strategy the user did not
      // choose is not a detail the server gets to decide.
      if (
        body.method !== "squash" &&
        body.method !== "merge" &&
        body.method !== "rebase"
      ) {
        respond(400, {
          error: "Invalid merge method: choose squash, merge or rebase.",
        });
        return;
      }
      respond(
        200,
        await mergeWorktreePullRequest(row, {
          method: body.method,
          ...(body.deleteBranch === false ? { deleteBranch: false } : {}),
        }),
      );
      return;
    }
    // `file-raw` streams bytes with its own content type (images, HTML
    // previews, downloads); everything else responds as JSON.
    if (verb === "file-raw") {
      const raw = await getWorktreeFileRaw(
        row,
        url.searchParams.get("path") ?? "",
        url.searchParams.get("ref")?.trim() || undefined,
      );
      res.writeHead(200, {
        "content-type": raw.contentType,
        "content-length": String(raw.content.byteLength),
        "cache-control": "no-store",
        "access-control-allow-origin":
          headers["access-control-allow-origin"] ?? "",
      });
      res.end(raw.content);
      return;
    }
    const payload = await dispatch(row, verb!, url.searchParams);
    if (payload === undefined) {
      respond(404, { error: "Not found" });
      return;
    }
    respond(200, payload);
  } catch (err) {
    const message = errorText(err);
    respond(
      /not found/i.test(message)
        ? 404
        : /conflict|could not fast-forward/i.test(message)
          ? 409
          : /invalid|not changed|too large|too long|too many|cannot be empty|not configured|hosting provider|has no branch|has no configured upstream|uncommitted changes|main checkout|cannot be retired|worktree is on|detached head/i.test(
                message,
              )
            ? 400
            : // Scoped to `merge-pr`: "already merged" is a state conflict for
              // THAT verb only, and the shared catch would otherwise re-code an
              // unrelated verb's message that happens to say the same words.
              verb === "merge-pr" &&
                /no pull request found|already merged|already closed/i.test(
                  message,
                )
              ? 409
              : 500,
      { error: message },
    );
  }
}

function scopeFromParams(params: URLSearchParams): WorktreeDiffScope {
  const from = params.get("from")?.trim();
  const to = params.get("to")?.trim();
  if (!from) return { kind: "workingTree" };
  if (!isSafeRef(from) || (to && !isSafeRef(to)))
    throw new Error("Invalid revision range.");
  return { kind: "range", from, ...(to ? { to } : {}) };
}

async function dispatch(
  row: WorktreeRow,
  verb: string,
  params: URLSearchParams,
): Promise<unknown> {
  switch (verb) {
    case "status":
      return computeWorktreeStatus(row);
    case "hosting":
      return worktreeHostingStatus(row);
    case "changes":
      return getWorktreeChanges(row, scopeFromParams(params));
    case "file-diff":
      return getWorktreeFileDiff(
        row,
        params.get("path") ?? "",
        scopeFromParams(params),
      );
    case "file":
      return getWorktreeFileContent(
        row,
        params.get("path") ?? "",
        params.get("ref")?.trim() || undefined,
      );
    case "log":
      return getWorktreeLog(row, Number(params.get("limit")) || 50);
    case "tree":
      return getWorktreeTree(
        row,
        params.get("path")?.trim() ?? "",
        params.get("includeIgnored") === "true",
      );
    default:
      return undefined;
  }
}
