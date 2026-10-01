/**
 * Worktree browser helpers: REST fetchers for the heavy read surfaces
 * (`/api/worktrees/:id/*`), grouping/status derivation for the sidebar and
 * detail views, and a small stale-while-revalidate cache keyed by
 * `worktreeId:updatedAt` so a watcher push naturally invalidates it.
 */
import type {
  WorktreeAutoCommitRequest,
  WorktreeAutoCommitResponse,
  WorktreeChangesResponse,
  WorktreeCleanResponse,
  WorktreeCommitRequest,
  WorktreeCommitResponse,
  WorktreeCreatePrRequest,
  WorktreeCreatePrResponse,
  WorktreeDiffScope,
  WorktreeHostingListResponse,
  WorktreeHostingStatusResponse,
  WorktreeFileDiffResponse,
  WorktreeFileResponse,
  WorktreeGitStatus,
  WorktreeLogResponse,
  WorktreeMergePrRequest,
  WorktreeMergePrResponse,
  WorktreePushRequest,
  WorktreePushResponse,
  WorktreeRecord,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
  WorktreeSyncOperation,
  WorktreeSyncResponse,
  WorktreeTreeEntry,
  SessionListItem,
  TaskSummary,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin, withToken } from "./serverOrigin.ts";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${serverHttpOrigin()}${path}`, {
    headers: { ...authHeaders() },
  });
  const body = (await res.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!res.ok || !body)
    throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${serverHttpOrigin()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload ?? {}),
  });
  const body = (await res.json().catch(() => null)) as
    (T & { error?: string }) | null;
  if (!res.ok || !body)
    throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}

function scopeParams(scope: WorktreeDiffScope): URLSearchParams {
  const params = new URLSearchParams();
  if (scope.kind === "range") {
    params.set("from", scope.from);
    if (scope.to) params.set("to", scope.to);
  }
  return params;
}

export function fetchWorktreeStatus(
  worktreeId: string,
): Promise<WorktreeGitStatus> {
  return getJson(`/api/worktrees/${encodeURIComponent(worktreeId)}/status`);
}

export function fetchWorktreeChanges(
  worktreeId: string,
  scope: WorktreeDiffScope,
): Promise<WorktreeChangesResponse> {
  const params = scopeParams(scope).toString();
  return getJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/changes${params ? `?${params}` : ""}`,
  );
}

export function fetchWorktreeFileDiff(
  worktreeId: string,
  path: string,
  scope: WorktreeDiffScope,
): Promise<WorktreeFileDiffResponse> {
  const params = scopeParams(scope);
  params.set("path", path);
  return getJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/file-diff?${params.toString()}`,
  );
}

export function fetchWorktreeFile(
  worktreeId: string,
  path: string,
  ref?: string,
): Promise<WorktreeFileResponse> {
  const params = new URLSearchParams({ path });
  if (ref) params.set("ref", ref);
  return getJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/file?${params.toString()}`,
  );
}

/** Provider-abstract PR/CI state for the worktree branch + HEAD. */
export function fetchWorktreeHosting(
  worktreeId: string,
): Promise<WorktreeHostingStatusResponse> {
  return getJson(`/api/worktrees/${encodeURIComponent(worktreeId)}/hosting`);
}

/**
 * Hosting for EVERY worktree in one request, for the surfaces that state each
 * row's PR/CI and cannot make a request per row. A worktree the server could
 * not reach is absent from `statuses` rather than empty, and the caller must
 * keep reading that absence as unknown.
 */
export function fetchWorktreeHostingAll(): Promise<WorktreeHostingListResponse> {
  return getJson(`/api/worktrees/hosting`);
}

/** Create a pull request for the worktree branch against its base. */
export function createWorktreePr(
  worktreeId: string,
  input: WorktreeCreatePrRequest,
): Promise<WorktreeCreatePrResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/create-pr`,
    input,
  );
}

/**
 * Merge the worktree branch's pull request and delete the remote branch, with
 * the method chosen on the button. Same server-side call as the chat card's
 * merge action; the LOCAL cleanup stays a separate decision.
 */
export function mergeWorktreePr(
  worktreeId: string,
  input: WorktreeMergePrRequest,
): Promise<WorktreeMergePrResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/merge-pr`,
    input,
  );
}

/** Stage + commit (everything, or a path subset) in the worktree. */
export function commitWorktree(
  worktreeId: string,
  input: WorktreeCommitRequest,
): Promise<WorktreeCommitResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/commit`,
    input,
  );
}

/** Generate a safe commit message and commit through the shared `/commit` workflow. */
export function autoCommitWorktree(
  worktreeId: string,
  input: WorktreeAutoCommitRequest = {},
): Promise<WorktreeAutoCommitResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/auto-commit`,
    input,
  );
}

/** Reset tracked content to HEAD and remove ordinary untracked files. */
export function cleanWorktree(
  worktreeId: string,
): Promise<WorktreeCleanResponse> {
  return postJson(`/api/worktrees/${encodeURIComponent(worktreeId)}/clean`, {});
}

/** Push the worktree branch (resolves/sets the upstream server-side). */
export function pushWorktree(
  worktreeId: string,
  input: WorktreePushRequest = {},
): Promise<WorktreePushResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/push`,
    input,
  );
}

/** Pull/rebase, rebase onto main, or ff-only merge back through the deterministic server workflow. */
export function syncWorktree(
  worktreeId: string,
  operation: WorktreeSyncOperation,
): Promise<WorktreeSyncResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/${operation}`,
    {},
  );
}

/** Refresh the base target, verify delivery, remove checkout/branch, and settle sessions. */
export function retireWorktree(
  worktreeId: string,
  input: WorktreeRetireRequest = {},
): Promise<WorktreeRetireResponse> {
  return postJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/retire`,
    input,
  );
}

export function fetchWorktreeLog(
  worktreeId: string,
  limit = 50,
): Promise<WorktreeLogResponse> {
  return getJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/log?limit=${limit}`,
  );
}

/**
 * Absolute, token-carrying URL for raw file bytes — usable directly as an
 * `<img>`/`<iframe>` source (those cannot send the auth header).
 */
export function worktreeFileRawUrl(
  worktreeId: string,
  path: string,
  ref?: string,
): string {
  const params = new URLSearchParams({ path });
  if (ref) params.set("ref", ref);
  return withToken(
    `${serverHttpOrigin()}/api/worktrees/${encodeURIComponent(worktreeId)}/file-raw?${params.toString()}`,
  );
}

export function fetchWorktreeTree(
  worktreeId: string,
  dir = "",
  includeIgnored = false,
): Promise<WorktreeTreeEntry[]> {
  const params = new URLSearchParams();
  if (dir) params.set("path", dir);
  if (includeIgnored) params.set("includeIgnored", "true");
  const query = params.toString();
  return getJson(
    `/api/worktrees/${encodeURIComponent(worktreeId)}/tree${query ? `?${query}` : ""}`,
  );
}

/**
 * Fast 53-bit string hash (cyrb53) over the given parts. Used to build pierre
 * highlight cache keys from file CONTENT rather than a server timestamp, so an
 * unchanged file refetched on a watcher tick reuses its cached tokenization
 * instead of re-highlighting the whole file (expensive for large files).
 */
export function hashContent(...parts: string[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      const ch = part.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/* --------------------------------- grouping -------------------------------- */

export interface WorktreeProjectGroup {
  projectId: string;
  worktrees: WorktreeRecord[];
}

/** Worktrees grouped by project (creation order inside a group). */
export function groupWorktreesByProject(
  worktrees: WorktreeRecord[],
): WorktreeProjectGroup[] {
  const groups = new Map<string, WorktreeRecord[]>();
  for (const worktree of worktrees) {
    const list = groups.get(worktree.projectId) ?? [];
    list.push(worktree);
    groups.set(worktree.projectId, list);
  }
  return [...groups.entries()]
    .map(([projectId, list]) => ({ projectId, worktrees: list }))
    .sort((a, b) => a.projectId.localeCompare(b.projectId));
}

/**
 * The worktree a Task is being implemented in, or `undefined` when none can be
 * identified. Two rules, strongest first:
 *
 * 1. the `task —in_worktree→ worktree` edge the record carries (`taskIds`)
 * 2. a session that claims this Task and itself runs in a live worktree
 *
 * Rule 2 exists because that edge is only written when a worktree is created
 * FOR a Task; picking up the same Task later in an existing worktree links the
 * SESSION, not the Task. Both rules break ties on the most recent activity, so
 * resuming a Task lands in the checkout it was last worked in rather than in
 * whichever row the list happened to yield first.
 *
 * Removed worktrees never count: a Task's edge outlives the checkout it names.
 */
export function worktreeForTask(
  taskId: string,
  worktrees: WorktreeRecord[] | null,
  sessions: SessionListItem[],
  tasks: TaskSummary[],
): string | undefined {
  const live = (worktrees ?? []).filter((worktree) => !worktree.removedAt);
  if (live.length === 0) return undefined;

  const linked = live.filter((worktree) => worktree.taskIds.includes(taskId));
  if (linked.length > 0) {
    return linked.reduce((newest, worktree) =>
      worktree.updatedAt > newest.updatedAt ? worktree : newest,
    ).id;
  }

  const claimed = new Set(
    (tasks.find((task) => task.id === taskId)?.sessionRefs ?? []).map(
      (ref) => ref.sessionId,
    ),
  );
  if (claimed.size === 0) return undefined;
  const liveIds = new Set(live.map((worktree) => worktree.id));
  let best: SessionListItem | undefined;
  for (const session of sessions) {
    if (
      !session.worktreeId ||
      !claimed.has(session.id) ||
      !liveIds.has(session.worktreeId)
    )
      continue;
    if (!best || session.updatedAt > best.updatedAt) best = session;
  }
  return best?.worktreeId;
}
