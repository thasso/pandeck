import { useCallback, useEffect, useRef, useState } from "react";
import {
  isGitHostingProviderKind,
  type GitHostingProviderKind,
  type SessionListItem,
} from "@assistant/shared";
import {
  documentTargetHref,
  parseDocumentLineAnchor,
  type DocumentLineAnchor,
} from "@assistant/shared/documentTargets";
import {
  resolveInternalDocumentTarget,
  sameDocumentIdentity,
} from "../lib/documentTargets.ts";
import {
  pushDocumentEntry,
  pushEntry,
  replaceEntry,
} from "../lib/historyNav.ts";
import {
  SESSIONS_CREATE_PATH,
  SESSIONS_PATH,
  sessionIdFromPathname,
  sessionPath,
} from "../lib/sessionRoutes.ts";

/**
 * Lightweight history-API routing. One canonical route shape per object type
 * plus section index routes (app/web/docs/ui-shell.md) — no legacy aliases:
 *
 *   /assistant           → the server-owned permanent Personal Assistant
 *   /sessions            → Sessions navigation surface (desktop: sidebar open
 *                          and focused; mobile: full-screen sessions sheet)
 *   /sessions/create     → fresh assistant chat (empty bootstrap landing)
 *   /sessions/:id        → the session with that id (any harness)
 *   /tasks               → reveals the sidebar Tasks section (no index page)
 *   /tasks/:id           → Task detail
 *   /projects            → Project detail placeholder (list lives in the sidebar)
 *   /projects/:id        → Project detail
 *   /pull-requests       → Pull Requests section index (a real surface)
 *   /pull-requests/:projectId/:provider/:repositoryKey/:number → one PR
 *   /calendar            → calendar surface (optionally /calendar/:view/:date)
 *   /knowledge                  → Knowledge Base surface
 *   /knowledge/:entryId         → Knowledge entry by stable kb.id
 *   /knowledge/~invalid/:path   → invalid entry (no kb.id) by folder path
 *   /knowledge/~file/:path      → a non-entry KB file (asset/loose) by tree path
 *   /usage               → provider account usage/rate-limit surface (Claude today)
 *   /files/:absolutePath → the file viewer for one live host file
 *   /artifacts/:session/:path → a captured session artifact
 *   /background-tasks    → the session-owned background work registry
 *   /background-tasks?task=:id → the same registry with one item anchored
 *   /settings            → Settings section index (desktop shows the default section)
 *   /settings/:section   → a stable settings section URL
 *
 * The URL and the server's active session are kept in sync in both directions:
 * navigating (deep link, sidebar click, back/forward) loads the addressed session
 * by id; the server creating or switching sessions updates the address bar.
 */
export const SETTINGS_SECTION_IDS = [
  "appearance",
  "profile",
  "about",
  "models",
  "claude-sdk",
  "openai",
  "openai-compatible",
  "personal-assistant",
  "memory",
  "naming",
  "refinement",
  "dictation",
  "notifications",
  "worktrees",
  "skills",
  "peer-runtimes",
  "background-processes",
  "port-forwarding",
  "commit",
  "pull-request",
  "task-intake",
  "day-scan",
  "minutes-scanner",
  "pdf-conversion",
  "browserTools",
  "google",
  "slack",
  "slack-huddles",
  "jira",
  "confluence",
  "tempo",
  "github",
  "forgejo",
  "web-search",
  "context7",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTION_IDS)[number];

export type WorktreeView = "changes" | "files";

export const PERMANENT_ASSISTANT_PATH = "/assistant";

export type Route =
  | { name: "permanentAssistant" }
  | { name: "session"; id: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "tasks"; id?: string }
  | { name: "projects"; id?: string }
  /**
   * The Pull Requests section. Addressing ONE pull request takes the same four
   * components the server joins on: project, provider, repository (`owner/repo`)
   * and number (`docs/pull-requests.md`). Every repository numbers from 1, one
   * project can hold two repositories, and `owner/repo` is only unique WITHIN a
   * provider — so dropping any of the four gives two pull requests one URL.
   */
  | {
      name: "pullRequests";
      projectId?: string;
      provider?: GitHostingProviderKind;
      repositoryKey?: string;
      number?: number;
    }
  | {
      name: "worktrees";
      id?: string;
      view?: WorktreeView;
      path?: string;
      from?: string;
      to?: string;
      anchor?: DocumentLineAnchor;
    }
  | { name: "calendar"; view?: "month" | "week" | "day"; date?: string }
  | {
      name: "knowledge";
      entryId?: string;
      entryPath?: string;
      filePath?: string;
      assetPath?: string;
      anchor?: DocumentLineAnchor;
    }
  | { name: "usage" }
  /**
   * The background-work registry. `taskId` anchors ONE item (the `?task=` link
   * the agent-facing tool hands a model to hand back to you); it is a PA id, and
   * an id the registry does not hold simply anchors nothing.
   */
  | { name: "backgroundTasks"; taskId?: string }
  /**
   * The viewer for ONE file on the host, addressed by its absolute path — the
   * same path the server serves bytes for under `/api/files/`. It has no
   * sidebar section: an agent's link is the only way in.
   */
  | { name: "files"; path: string; anchor?: DocumentLineAnchor }
  | {
      name: "artifacts";
      sessionId: string;
      path: string;
      anchor?: DocumentLineAnchor;
    }
  | { name: "sessions" }
  | { name: "new" };

export function settingsPath(section: SettingsSection): string {
  return `/settings/${section}`;
}

export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

export function projectPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}

const PULL_REQUESTS_PATH = "/pull-requests";

/**
 * The Pull Requests index, or ONE pull request.
 *
 * The repository key is one percent-encoded SEGMENT, `/` included: it is a
 * single opaque identifier (`owner/repo`), not two path components, and letting
 * its slash through would make the tail of this shape unparseable.
 */
export function pullRequestPath(target?: {
  projectId: string;
  provider: GitHostingProviderKind;
  repositoryKey: string;
  number: number;
}): string {
  if (!target) return PULL_REQUESTS_PATH;
  const segments = [
    encodeURIComponent(target.projectId),
    encodeURIComponent(target.provider),
    encodeURIComponent(target.repositoryKey),
    String(target.number),
  ];
  return `${PULL_REQUESTS_PATH}/${segments.join("/")}`;
}

/** Knowledge Base surface, or one entry addressed by its stable `kb.id`. */
export function knowledgePath(entryId?: string): string {
  return entryId ? `/knowledge/${encodeURIComponent(entryId)}` : "/knowledge";
}

/**
 * Route for an entry addressed by folder path rather than id. Invalid entries
 * have no parseable `kb.id`, so they are reachable only by path. The reserved
 * `~invalid/` prefix cannot collide with a `kb.id` (ids never contain `/`).
 */
export function knowledgeEntryPath(folder: string): string {
  const encoded = folder.split("/").map(encodeURIComponent).join("/");
  return `/knowledge/~invalid/${encoded}`;
}

/**
 * Route for a non-entry KB file (an entry asset or a loose file) addressed by
 * its full tree path, so it can be viewed in the main pane. The reserved
 * `~file/` prefix cannot collide with a `kb.id` (ids never contain `/`).
 */
export function knowledgeFilePath(path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `/knowledge/~file/${encoded}`;
}

/** Provider account usage/rate-limit surface. */
export function usagePath(): string {
  return "/usage";
}

/**
 * Viewer route for one host file. The absolute path becomes the route path, as
 * it does in the API URL, so a rendered document's relative references and its
 * address agree.
 */
export function fileViewerPath(
  absolutePath: string,
  anchor?: DocumentLineAnchor,
): string {
  return documentTargetHref({
    kind: "hostFile",
    path: absolutePath,
    ...(anchor ? { anchor } : {}),
  });
}

export function sessionArtifactPath(
  sessionId: string,
  path: string,
  anchor?: DocumentLineAnchor,
): string {
  return documentTargetHref({
    kind: "sessionArtifact",
    sessionId,
    path,
    ...(anchor ? { anchor } : {}),
  });
}

const BACKGROUND_TASKS_PATH = "/background-tasks";

/**
 * The background-work registry, optionally anchored on one item. The same shape
 * the server's `background_tasks` tool hands a model as `humanLink`, so a link
 * that reaches the user from an agent resolves here without translation.
 */
export function backgroundTasksPath(taskId?: string): string {
  return taskId
    ? `${BACKGROUND_TASKS_PATH}?task=${encodeURIComponent(taskId)}`
    : BACKGROUND_TASKS_PATH;
}

export function worktreePath(
  id: string,
  view?: WorktreeView,
  query?: { path?: string; from?: string; to?: string },
): string {
  const base = `/worktrees/${encodeURIComponent(id)}${view ? `/${view}` : ""}`;
  const params = new URLSearchParams();
  if (query?.path) params.set("path", query.path);
  if (query?.from) params.set("from", query.from);
  if (query?.to) params.set("to", query.to);
  const search = params.toString();
  return search ? `${base}?${search}` : base;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar surface, deep-linked to a view + user-local day for stable links. */
export function calendarPath(
  view?: "month" | "week" | "day",
  date?: string,
): string {
  if (view && date && ISO_DATE_RE.test(date))
    return `/calendar/${view}/${date}`;
  return "/calendar";
}

const SETTINGS_SECTION_RE = new RegExp(
  `^/settings/(${SETTINGS_SECTION_IDS.join("|")})/?$`,
);

/** Parse a location (path + optional search/hash) into its canonical route. */
export function parseRoute(pathAndSearch: string): Route {
  const hashIndex = pathAndSearch.indexOf("#");
  const hash = hashIndex >= 0 ? pathAndSearch.slice(hashIndex + 1) : "";
  const anchor = parseDocumentLineAnchor(hash);
  const withoutHash =
    hashIndex >= 0 ? pathAndSearch.slice(0, hashIndex) : pathAndSearch;
  const queryIndex = withoutHash.indexOf("?");
  const pathname =
    queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  if (
    pathname === PERMANENT_ASSISTANT_PATH ||
    pathname === `${PERMANENT_ASSISTANT_PATH}/`
  )
    return { name: "permanentAssistant" };
  if (
    pathname === SESSIONS_CREATE_PATH ||
    pathname === `${SESSIONS_CREATE_PATH}/`
  )
    return { name: "new" };
  if (pathname === SESSIONS_PATH || pathname === `${SESSIONS_PATH}/`)
    return { name: "sessions" };
  if (pathname === "/tasks" || pathname === "/tasks/") return { name: "tasks" };
  const taskDetail = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (taskDetail?.[1])
    return { name: "tasks", id: decodeURIComponent(taskDetail[1]) };
  if (pathname === "/projects" || pathname === "/projects/")
    return { name: "projects" };
  const projectDetail = pathname.match(/^\/projects\/([^/]+)\/?$/);
  if (projectDetail?.[1])
    return { name: "projects", id: decodeURIComponent(projectDetail[1]) };
  if (pathname === PULL_REQUESTS_PATH || pathname === `${PULL_REQUESTS_PATH}/`)
    return { name: "pullRequests" };
  const pullRequestDetail = pathname.match(
    /^\/pull-requests\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)\/?$/,
  );
  if (pullRequestDetail) {
    const [, projectId, provider, repositoryKey, number] = pullRequestDetail;
    const kind = decodeURIComponent(provider!);
    // A provider this build does not have addresses nothing, so the whole
    // detail route is rejected rather than parsed into an id that can never
    // resolve — the shared vocabulary decides, never a second literal here.
    if (isGitHostingProviderKind(kind)) {
      return {
        name: "pullRequests",
        projectId: decodeURIComponent(projectId!),
        provider: kind,
        repositoryKey: decodeURIComponent(repositoryKey!),
        number: Number(number!),
      };
    }
  }
  // `/worktrees` has no index: a worktree is browsed on its Project page, and
  // the sidebar section that used to list them is Pull Requests now. The
  // DETAIL route below (changes/files) is untouched.
  const worktreeDetail = pathname.match(
    /^\/worktrees\/([^/]+)(?:\/(changes|files))?\/?$/,
  );
  if (worktreeDetail?.[1]) {
    const params = new URLSearchParams(
      queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "",
    );
    const pathValue = params.get("path") ?? undefined;
    const viewValue =
      (worktreeDetail[2] as WorktreeView | undefined) ??
      (pathValue
        ? params.get("view") === "diff"
          ? "changes"
          : "files"
        : undefined);
    const fromValue = params.get("from") ?? undefined;
    const toValue = params.get("to") ?? undefined;
    return {
      name: "worktrees",
      id: decodeURIComponent(worktreeDetail[1]),
      ...(viewValue !== undefined ? { view: viewValue } : {}),
      ...(pathValue !== undefined ? { path: pathValue } : {}),
      ...(fromValue !== undefined ? { from: fromValue } : {}),
      ...(toValue !== undefined ? { to: toValue } : {}),
      ...(anchor ? { anchor } : {}),
    };
  }
  if (pathname === "/knowledge" || pathname === "/knowledge/")
    return { name: "knowledge" };
  const knowledgeInvalid = pathname.match(/^\/knowledge\/~invalid\/(.+?)\/?$/);
  if (knowledgeInvalid?.[1]) {
    return {
      name: "knowledge",
      entryPath: knowledgeInvalid[1]
        .split("/")
        .map(decodeURIComponent)
        .join("/"),
      ...(anchor ? { anchor } : {}),
    };
  }
  const knowledgeFile = pathname.match(/^\/knowledge\/~file\/(.+?)\/?$/);
  if (knowledgeFile?.[1]) {
    return {
      name: "knowledge",
      filePath: knowledgeFile[1].split("/").map(decodeURIComponent).join("/"),
      ...(anchor ? { anchor } : {}),
    };
  }
  const knowledgeDetail = pathname.match(/^\/knowledge\/([^/]+)\/?$/);
  if (knowledgeDetail?.[1]) {
    const params = new URLSearchParams(
      queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "",
    );
    const assetPath = params.get("asset") ?? undefined;
    return {
      name: "knowledge",
      entryId: decodeURIComponent(knowledgeDetail[1]),
      ...(assetPath ? { assetPath } : {}),
      ...(anchor ? { anchor } : {}),
    };
  }
  if (pathname === "/usage" || pathname === "/usage/") return { name: "usage" };
  const fileViewer = pathname.match(/^\/files\/(.+?)\/?$/);
  if (fileViewer?.[1]) {
    return {
      name: "files",
      path: `/${fileViewer[1].split("/").map(decodeURIComponent).join("/")}`,
      ...(anchor ? { anchor } : {}),
    };
  }
  const artifactViewer = pathname.match(/^\/artifacts\/([^/]+)\/(.+?)\/?$/);
  if (artifactViewer?.[1] && artifactViewer[2]) {
    return {
      name: "artifacts",
      sessionId: decodeURIComponent(artifactViewer[1]),
      path: artifactViewer[2].split("/").map(decodeURIComponent).join("/"),
      ...(anchor ? { anchor } : {}),
    };
  }
  if (
    pathname === BACKGROUND_TASKS_PATH ||
    pathname === `${BACKGROUND_TASKS_PATH}/`
  ) {
    const anchored = new URLSearchParams(
      queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : "",
    ).get("task");
    return {
      name: "backgroundTasks",
      ...(anchored ? { taskId: anchored } : {}),
    };
  }
  if (pathname === "/calendar" || pathname === "/calendar/")
    return { name: "calendar" };
  const calendarFull = pathname.match(
    /^\/calendar\/(month|week|day)\/(\d{4}-\d{2}-\d{2})\/?$/,
  );
  if (calendarFull?.[1] && calendarFull[2])
    return {
      name: "calendar",
      view: calendarFull[1] as "month" | "week" | "day",
      date: calendarFull[2],
    };
  const calendarDay = pathname.match(/^\/calendar\/(\d{4}-\d{2}-\d{2})\/?$/);
  if (calendarDay?.[1])
    return { name: "calendar", view: "day", date: calendarDay[1] };
  if (pathname === "/settings" || pathname === "/settings/")
    return { name: "settings" };
  const settings = pathname.match(SETTINGS_SECTION_RE);
  if (settings?.[1])
    return { name: "settings", section: settings[1] as SettingsSection };

  const sessionId = sessionIdFromPathname(pathname);
  if (sessionId) return { name: "session", id: sessionId };

  // Anything else → the new-chat landing.
  return { name: "new" };
}

/**
 * Whether a route is a **section index route** — a section addressed with no
 * object (`/tasks`, `/knowledge`, `/settings`, …). On small screens these are the
 * browser screens: the left sidebar fills the viewport instead of the main pane
 * (app/web/docs/ui-shell.md, Small Screens). Action surfaces without a section
 * (`/usage`, `/assistant`, `/sessions/create`) are never index routes.
 */
export function isSectionIndexRoute(route: Route): boolean {
  switch (route.name) {
    case "sessions":
      return true;
    case "tasks":
    case "projects":
      return !route.id;
    case "pullRequests":
      return route.number === undefined;
    case "worktrees":
      // `/worktrees/:id/...` is the only worktree route left, and it is always
      // an object screen.
      return false;
    case "knowledge":
      return !route.entryId && !route.entryPath && !route.filePath;
    case "calendar":
      // A bare /calendar is the index; a view+date addresses the calendar itself.
      return !route.date;
    case "settings":
      return !route.section;
    default:
      return false;
  }
}

/** A stable key identifying what we last reconciled, so we don't re-issue commands. */
function routeKey(route: Route): string {
  if (route.name === "permanentAssistant") return "permanentAssistant";
  if (route.name === "new") return "new";
  if (route.name === "sessions") return "sessions";
  if (route.name === "settings") return `settings:${route.section ?? "index"}`;
  if (route.name === "tasks") return route.id ? `tasks:${route.id}` : "tasks";
  if (route.name === "projects")
    return route.id ? `projects:${route.id}` : "projects";
  if (route.name === "pullRequests")
    return route.number === undefined
      ? "pullRequests"
      : `pullRequests:${route.projectId}:${route.provider}:${route.repositoryKey}:${route.number}`;
  if (route.name === "worktrees")
    return route.id
      ? `worktrees:${route.id}:${route.view ?? "changes"}`
      : "worktrees";
  if (route.name === "calendar")
    return route.date
      ? `calendar:${route.view ?? "month"}:${route.date}`
      : "calendar";
  if (route.name === "knowledge")
    return route.entryId
      ? `knowledge:${route.entryId}`
      : route.entryPath
        ? `knowledge:~invalid:${route.entryPath}`
        : route.filePath
          ? `knowledge:~file:${route.filePath}`
          : "knowledge";
  if (route.name === "usage") return "usage";
  if (route.name === "backgroundTasks")
    return `backgroundTasks:${route.taskId ?? ""}`;
  if (route.name === "files")
    return `files:${route.path}:${route.anchor?.start ?? ""}:${route.anchor?.end ?? ""}`;
  if (route.name === "artifacts")
    return `artifacts:${route.sessionId}:${route.path}:${route.anchor?.start ?? ""}:${route.anchor?.end ?? ""}`;
  return `session:${route.id}`;
}

/**
 * Decide whether an armed staged first-send advance may adopt `currentId` as
 * the session the send created. The created session is necessarily NEW, so the
 * id must be absent from the set of session ids known at the send moment —
 * every other frame that can move the viewed session mid-staging (a late
 * loadSession snapshot, a background session's frames settling, a
 * server-initiated view switch) names an already-existing session and must
 * never be adopted. Returns the id to advance to, or null.
 */
export function stagedSendCreatedSession(
  currentId: string | undefined,
  hasMessages: boolean,
  knownIdsAtArm: ReadonlySet<string> | null,
): string | null {
  if (!currentId || !hasMessages || !knownIdsAtArm) return null;
  return knownIdsAtArm.has(currentId) ? null : currentId;
}

/**
 * Whether a session that projects ZERO messages may be canonicalized to
 * `/sessions/create`. Trust the list over the projection: a session the list
 * says has messages is a snapshot that failed to render (Task 449 — a windowed
 * snapshot of nothing but orphan tool results), not a bootstrap session, and
 * rehoming it to the create page would make a real conversation unreachable.
 *
 * The list is evidence only once it EXISTS: on a cold deep link the snapshot
 * arrives before `ready`'s session list, so an id the (empty) list does not
 * know is "not yet known", never "empty" — withhold judgement until the shell
 * is hydrated (from cache, which keeps `messageCount`, or from `ready`).
 */
export function canonicalizeEmptySessionToCreate(
  hydrated: boolean,
  sessions: readonly SessionListItem[],
  id: string,
): boolean {
  if (!hydrated) return false;
  return !sessions.some((s) => s.id === id && s.messageCount > 0);
}

function routeMatchesServer(
  route: Route,
  currentId: string | undefined,
  hasMessages: boolean,
): boolean {
  if (route.name === "permanentAssistant") return true;
  if (
    route.name === "settings" ||
    route.name === "tasks" ||
    route.name === "projects" ||
    route.name === "pullRequests" ||
    route.name === "worktrees" ||
    route.name === "calendar" ||
    route.name === "knowledge" ||
    route.name === "usage" ||
    route.name === "backgroundTasks" ||
    route.name === "files" ||
    route.name === "artifacts"
  )
    return false;
  if (route.name === "new" || route.name === "sessions") return !hasMessages;
  return currentId === route.id;
}

interface Args {
  connected: boolean;
  /** Whether the shell holds a session list (cache or `ready`) — before that,
   *  an id absent from `sessions` is unknown, not empty. */
  hydrated: boolean;
  sessions: SessionListItem[];
  currentId: string | undefined;
  /** Whether the active session has any messages — an empty bootstrap session
   *  stays at `/sessions/create` rather than being given a `/sessions/:id` address. */
  hasMessages: boolean;
  /** View a session addressed by OUR id. */
  loadSession: (id: string) => void;
  /** Create/restore and view the server-owned singleton Personal Assistant. */
  openPermanentAssistant: () => void;
}

export function useSessionRouting({
  connected,
  hydrated,
  sessions,
  currentId,
  hasMessages,
  loadSession,
  openPermanentAssistant,
}: Args): {
  route: Route;
  navigate: (path: string) => void;
  notifyStagedFirstSend: () => void;
} {
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(location.pathname + location.search + location.hash),
  );
  // The route last reconciled against the server, so we don't re-issue
  // load/new commands on unrelated re-renders.
  const applied = useRef<string | null>(null);
  // Route changes are applied asynchronously by the server. While a requested
  // session/home route is pending, don't let the still-visible old session push
  // its URL back into the address bar.
  const pending = useRef<string | null>(null);
  // The staged route (`/sessions/create`, `/sessions`) only canonicalizes to a
  // real session id after the user sends the first prompt from it (armed via
  // notifyStagedFirstSend, disarmed on advance and on any explicit
  // navigate/popstate). The advance may adopt ONLY a session that did not exist
  // when the send happened: the session the first prompt creates is necessarily
  // new, while every other frame that can move `currentId` mid-staging — a late
  // loadSession snapshot still in flight, a server-initiated view switch, a
  // background session's state settling after reconnect — can only name an
  // ALREADY-EXISTING session. Comparing against a baseline id captured at
  // staging entry (the previous approach) was not enough: the baseline itself
  // could be stale while a load was in flight, and any post-send drift frame
  // was adopted as if the send had created it.
  const stagedFirstSend = useRef(false);
  const stagedKnownIdsAtArm = useRef<ReadonlySet<string> | null>(null);
  // Arm-time snapshots read these instead of effect-captured props so the known
  // set reflects the exact send moment.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  useEffect(() => {
    const onPop = () => {
      // Back/forward is never a programmatic first-send, so cancel any armed
      // staged advance before adopting the popped route.
      stagedFirstSend.current = false;
      stagedKnownIdsAtArm.current = null;
      setRoute(parseRoute(location.pathname + location.search + location.hash));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A reconnect starts from the server shell without creating an empty chat
  // session. Forget the route we had already applied before the socket dropped,
  // otherwise a deep linked `/sessions/:id` can stay in the URL while the UI
  // shows the dashboard.
  useEffect(() => {
    if (connected) return;
    applied.current = null;
    pending.current = null;
  }, [connected]);

  // Route → server: load the addressed session by id, or start a fresh one. The
  // settings/tasks/projects routes are pure UI overlays and are left untouched.
  useEffect(() => {
    if (
      !connected ||
      route.name === "settings" ||
      route.name === "tasks" ||
      route.name === "projects" ||
      route.name === "pullRequests" ||
      route.name === "worktrees" ||
      route.name === "calendar" ||
      route.name === "knowledge" ||
      route.name === "usage" ||
      route.name === "backgroundTasks" ||
      route.name === "files" ||
      route.name === "artifacts"
    )
      return;

    if (route.name === "permanentAssistant") {
      const key = routeKey(route);
      if (applied.current !== key) {
        applied.current = key;
        pending.current = key;
        openPermanentAssistant();
      }
      return;
    }

    // /sessions/create and /sessions are purely client-staged. Do not create a
    // server session until the first prompt is sent.
    if (route.name === "new" || route.name === "sessions") {
      applied.current = routeKey(route);
      pending.current = null;
      return;
    }

    // Session route: match by id only. Availability is enforced in the picker;
    // the server view-if-exists handles unknown/optimistic ids.
    const key = routeKey(route);
    if (currentId === route.id) {
      applied.current = key;
      pending.current = null;
      return;
    }
    if (applied.current !== key || pending.current !== key) {
      applied.current = key;
      pending.current = key;
      loadSession(route.id);
    }
  }, [
    route,
    connected,
    currentId,
    hasMessages,
    loadSession,
    openPermanentAssistant,
  ]);

  // Server → URL: address non-empty conversations and keep empty sessions at the
  // new-chat URL. If a route we asked the server to load/create is still
  // pending, leave the address bar alone until the server state catches up.
  useEffect(() => {
    if (
      route.name === "permanentAssistant" ||
      route.name === "settings" ||
      route.name === "tasks" ||
      route.name === "projects" ||
      route.name === "pullRequests" ||
      route.name === "worktrees" ||
      route.name === "calendar" ||
      route.name === "knowledge" ||
      route.name === "usage" ||
      route.name === "backgroundTasks" ||
      route.name === "files" ||
      route.name === "artifacts"
    )
      return;

    if (route.name === "new" || route.name === "sessions") {
      // Follow `currentId` only once the user has sent the first prompt from
      // this staging route, and only to a session the send actually created
      // (see stagedSendCreatedSession).
      const created = stagedFirstSend.current
        ? stagedSendCreatedSession(
            currentId,
            hasMessages,
            stagedKnownIdsAtArm.current,
          )
        : null;
      if (created) {
        const target = sessionPath(created);
        if (location.pathname !== target) replaceEntry(target);
        setRoute({ name: "session", id: created });
        applied.current = `session:${created}`;
        stagedFirstSend.current = false;
        stagedKnownIdsAtArm.current = null;
      }
      return;
    }

    const key = routeKey(route);
    const matchesServer = routeMatchesServer(route, currentId, hasMessages);
    if (pending.current === key) {
      const pendingUnknownSession =
        route.name === "session" &&
        hasMessages &&
        !!currentId &&
        !sessions.some((session) => session.id === route.id);
      if (!matchesServer && !pendingUnknownSession) return;
      pending.current = null;
    }

    if (hasMessages && currentId) {
      const target = sessionPath(currentId);
      if (location.pathname !== target) {
        replaceEntry(target);
        setRoute({ name: "session", id: currentId });
        applied.current = `session:${currentId}`;
      }
    } else if (
      route.name === "session" &&
      !hasMessages &&
      currentId === route.id &&
      canonicalizeEmptySessionToCreate(hydrated, sessions, route.id)
    ) {
      // An empty (bootstrap) session lives at /sessions/create, not at an id URL.
      if (location.pathname !== SESSIONS_CREATE_PATH) {
        replaceEntry(SESSIONS_CREATE_PATH);
      }
      setRoute({ name: "new" });
      applied.current = "new";
    }
  }, [currentId, hasMessages, hydrated, route, sessions]);

  const navigate = useCallback((path: string) => {
    // Any explicit navigation cancels a still-armed staged advance. Callers that
    // navigate to the staging route AND immediately send (e.g. inspector "start
    // chat") re-arm via notifyStagedFirstSend right after this call.
    stagedFirstSend.current = false;
    stagedKnownIdsAtArm.current = null;
    const currentHref = location.pathname + location.search + location.hash;
    let routePath = path;
    if (currentHref !== path) {
      const nextDocument = resolveInternalDocumentTarget(path);
      const currentDocument = resolveInternalDocumentTarget(currentHref);
      const sameDocument =
        nextDocument !== null &&
        currentDocument !== null &&
        sameDocumentIdentity(nextDocument, currentDocument);
      // Valid line anchors are part of document navigation even when the source
      // identity is unchanged. Unrelated fragments such as transcript `#m-*`
      // parse with no document anchor and must not manufacture an entry.
      const hashIndex = path.indexOf("#");
      const unrelatedFragment =
        hashIndex >= 0 &&
        parseDocumentLineAnchor(path.slice(hashIndex + 1)) === undefined;
      const changedLineAnchor =
        sameDocument &&
        !unrelatedFragment &&
        nextDocument !== null &&
        currentDocument !== null &&
        documentTargetHref(nextDocument) !==
          documentTargetHref(currentDocument);
      if (!sameDocument || changedLineAnchor) {
        if (nextDocument) pushDocumentEntry(path);
        else pushEntry(path);
      } else {
        routePath = currentHref;
      }
    }
    // Re-parse even for same-path clicks so a sidebar item can recover from a
    // stale/pending route state without requiring a separate navigation first.
    setRoute(parseRoute(routePath));
  }, []);

  // App calls this when the user sends the first prompt from a staging route,
  // for BOTH harnesses (pi mints the id server-side; claude-sdk keeps the staged
  // client id — but that id is not in the session list until the server creates
  // it, so navigating to it directly would trip the pending-unknown-session
  // fallback and canonicalize the URL back to the previously viewed session).
  // It arms the one-shot URL advance in the Server → URL effect above and
  // snapshots every session id known at the send moment (sidebar rows plus the
  // currently viewed id), so the advance can distinguish the session the send
  // CREATES from any pre-existing session that drifts into view afterwards.
  const notifyStagedFirstSend = useCallback(() => {
    const known = new Set(sessionsRef.current.map((session) => session.id));
    const viewed = currentIdRef.current;
    if (viewed) known.add(viewed);
    stagedKnownIdsAtArm.current = known;
    stagedFirstSend.current = true;
  }, []);

  return { route, navigate, notifyStagedFirstSend };
}
