// FIRST: refuse to start on a DATA_DIR another live server holds, before any
// module below opens the database or writes under it.
import { serverBootLock } from "./serverBootLock.ts";
// Next: under Bun, SIGUSR1 would otherwise end the process during boot.
import "./heapSnapshotSignal.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { WebSocketServer } from "ws";
import type {
  GithubLinkedIssuesResponse,
  JiraLinkedIssuesResponse,
  PromptRefineRequest,
  PromptRefineResponse,
  SpeechTranscribeResponse,
  TimelineCacheDescriptor,
} from "@assistant/shared";
import { normalizeGithubIssueRefs } from "@assistant/shared";
import type {
  PortForwardGrantRequest,
  PortForwardGrantRevokeRequest,
} from "@assistant/shared/portForwarding";
import { formatBuildInfo } from "@assistant/shared/buildInfo";
import { DATA_DIR, HOST, IS_PROD, PORT, PUBLIC_BASE_URL } from "./config.ts";
import { authTokenStartupMessage, resolveAuthToken } from "./authToken.ts";
import { scrubInstanceEnvironment } from "./instanceEnv.ts";
import { startSpawnBroker } from "./spawnBroker.ts";
import { startChildOomScoreRelease } from "./childOomScore.ts";
import { memoryLogLine, startMemoryLog } from "./memoryLog.ts";
import { assertPromptAssets } from "./promptAssets.ts";
import { verifyRequiredHostTools } from "./hostTools.ts";
import { Connection } from "./connection.ts";
import { getGoogleDriveFileTextPreview } from "./tools/google/googleDriveTools.ts";
import { getGmailThreadTextPreview } from "./tools/google/googleGmailTools.ts";
import { getCalendarEvents } from "./calendarService.ts";
import { CLAUDE_SDK_MODELS } from "./claudeSdk/modelSettings.ts";
import { redeemOpenAiResetCreditForProfile } from "./piSdk/openaiUsageQuery.ts";
import {
  createCredentialProfile,
  credentialProfileById,
  defaultClaudeProfileId,
  defaultOpenAiProfileId,
  deleteCredentialProfile,
  listCredentialProfiles,
  renameCredentialProfile,
  setCredentialProfileEnabled,
} from "./credentialProfiles.ts";
import {
  markUsageProfileDirty,
  readUsageSnapshot,
  revalidateUsage,
} from "./usageCache.ts";
import {
  clearProfilePins,
  listCredentialProfilesWithUsage,
} from "./credentialProfileUsage.ts";
import {
  listModelsForProfile,
  modelRuntimeForProfile,
  startOpenAiProfileLogin,
  warmCredentialProfileModelRuntimes,
} from "./piSdk/models.ts";
import { linkPiToolBinaries } from "./piSdk/toolBinaries.ts";
import { getDayState } from "./dayScan/dayState.ts";
import {
  runDayCollection,
  stopDayCollection,
} from "./dayScan/collectionRun.ts";
import { runDaySynthesis } from "./dayScan/synthesisRunner.ts";
import {
  startDayScanSchedule,
  stopDayScanSchedule,
} from "./dayScan/schedule.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";
import {
  createGoogleOAuthStartUrl,
  handleGoogleOAuthCallback,
} from "./googleSettings.ts";
import {
  createSlackOAuthStartUrl,
  handleSlackOAuthCallback,
} from "./slackSettings.ts";
import {
  createTempoOAuthStartUrl,
  handleTempoOAuthCallback,
} from "./tempoSettings.ts";
import { getJiraCredsIfAvailable } from "./jiraSettings.ts";
import { jiraIssueUrl, resolveJiraIssueInfos } from "./jiraClient.ts";
import { resolveGithubLinkedIssues } from "./githubLinkedIssues.ts";
import { getGithubConfigIfAvailable } from "./githubSettings.ts";
import { slackSocketMode } from "./slackSocketMode.ts";
import {
  startSlackShortcutIntake,
  stopSlackShortcutIntake,
} from "./slackShortcutIntake.ts";
import {
  startPermanentAssistant,
  stopPermanentAssistant,
} from "./permanentAssistant.ts";
import {
  startMemoryMaintenance,
  stopMemoryMaintenance,
} from "./memory/memoryScheduler.ts";
import {
  startSlackAssistantChat,
  stopSlackAssistantChat,
} from "./slackAssistantChat.ts";
import { hub } from "./hub.ts";
import {
  backgroundWorkSupervisor,
  BACKGROUND_EVENT_RATE_TERMINAL_REASON,
} from "./backgroundWork/supervisor.ts";
import type { BackgroundWorkItem } from "./db/backgroundWorkStore.ts";
import {
  BackgroundCompletionDelivery,
  backgroundCompletionTurns,
} from "./backgroundWork/completionDelivery.ts";
import { backgroundCompletionDisposition } from "./backgroundWork/deliveryPolicy.ts";
import {
  removeBackgroundDeliveryOutput,
  writeBackgroundDeliveryOutput,
} from "./backgroundWork/deliveryOutput.ts";
import { sessionArtifactFile } from "./mcp/toolGroups/packRuntime.ts";
import {
  promptRuntimeSession,
  setDeferredBackgroundContextProvider,
  type RuntimePromptDriver,
} from "./session/runtimePrompt.ts";
import {
  SessionBusyError,
  SteerNotTakenError,
} from "./session/runtime/errors.ts";
import {
  startTaskAutoArchiveSweep,
  stopTaskAutoArchiveSweep,
} from "./tasks.ts";
import {
  startSessionAutoArchiveSweep,
  stopSessionAutoArchiveSweep,
} from "./sessionRetention.ts";
import {
  startOpenAiResetAutoRedeemSweep,
  stopOpenAiResetAutoRedeemSweep,
} from "./openaiResetAutoRedeem.ts";
import { sweepMainWorktreeCommentRetention } from "./worktrees/worktreeComments.ts";
import { closeDb } from "./db/index.ts";
import { sessionStore } from "./db/sessionStore.ts";
import {
  buildVisibleConversationContext,
  refinePromptText,
} from "./promptRefinement.ts";
import {
  attachSpeechSocket,
  finalizeTranscript,
  maxUtteranceBytes,
  pcm16ToFloat32,
} from "./speech/speechSocket.ts";
import {
  attachClaudeLoginSocket,
  stopClaudeLoginTerminals,
} from "./claudeLoginTerminal.ts";
import { sttEngine } from "./speech/sttEngine.ts";
import { getSettings } from "./settings.ts";
import { validateClientMessage } from "./validateClientMessage.ts";
import { handleWorktreeApi } from "./worktrees/worktreeHttp.ts";
import { handlePullRequestApi } from "./pullRequestHttp.ts";
import { handleKnowledgeBaseApi } from "./knowledgeBaseHttp.ts";
import { handleSkillsApi } from "./skills/skillsHttp.ts";
import { handleApnsApi } from "./apnsHttp.ts";
import { handleWebPushApi } from "./webPushHttp.ts";
import { errorText } from "./errors.ts";
import { reconcileMissingPiSessionMetadata } from "./sessions.ts";
import {
  installSessionActivityTracking,
  markInterruptedRunsOnBoot,
  settleCompletedWorkflowRunSessionsOnBoot,
} from "./sessionActivity.ts";
import { registerPdfClaudeFallback } from "./pdfClaudeFallback.ts";
import { startPackageProxyIfEnabled } from "./packageProxy/packageProxy.ts";
import { bootStep } from "./bootStep.ts";
import {
  reconcileBackgroundWorkOnBoot,
  sweepBackgroundTaskOutputTemps,
  tombstoneDeletedOwnersOnBoot,
} from "./backgroundWorkBoot.ts";
import {
  closeChainsForHumanPrompt,
  drainAllQueuedOnBoot,
  drainRecipient,
  recoverPeerPromptsOnBoot,
  RETRY_SWEEP_INTERVAL_MS,
  runPeerPromptRetention,
  stopPeerPromptDelivery,
  sweepExpiredLeases,
  sweepPeerPromptRetries,
} from "./peerPrompt.ts";
import {
  drainAgentHandoffs,
  recoverAgentHandoffsOnBoot,
  stopAgentHandoffDelivery,
} from "./agentHandoffs.ts";
import {
  drainPromptQueue,
  drainPromptQueuesOnBoot,
  setPromptQueueHost,
  stopPromptQueueDelivery,
  type PromptQueueDriver,
} from "./promptQueue.ts";
import {
  recoverAutoApprovalsOnBoot,
  runAutoApprovals,
} from "./pendingApprovals.ts";
import {
  setHumanPromptHook,
  setSessionIdleHook,
  subscribeSessionRunCompleted,
  subscribeSessionToolCompleted,
} from "./session/runtime/liveSession.ts";
import { humanPromptHandler } from "./spawnOwnership.ts";
import { notifySessionTurnCompleted } from "./webPush.ts";
import { serverBuildInfo } from "./buildInfo.ts";
import { sessionArtifactDeliveryHeaders } from "./sessionArtifactHttp.ts";
import {
  DIRECT_FILE_PREFIX,
  handleDirectFileRequest,
} from "./directFileHttp.ts";
import {
  FILE_GRANT_PREFIX,
  handleFileGrantRequest,
} from "./directFileGrants.ts";
import {
  mintDocumentTargetGrant,
  parseMintFileGrantRequest,
} from "./documentGrantTargets.ts";
import { apiPathSkipsAuth } from "./apiAuthPolicy.ts";
import { webBuildId } from "./webBuild.ts";
import {
  attachPortForwardSocket,
  bearerGrant,
  PortForwardGrantError,
  PortForwardGrantStore,
  PORT_FORWARD_MAX_FRAME_BYTES,
  PORT_FORWARD_PATH,
} from "./portForwarding.ts";
import { assertPackagedRuntimeAssets, WEB_DIST_DIR } from "./runtimeAssets.ts";
import { contentTypeFor, serveWebStatic } from "./webStatic.ts";

const WEB_DIST = WEB_DIST_DIR;
const WEB_BUILD_ID = webBuildId(join(WEB_DIST, "index.html"));

/** Conservative id allow-list for path segments (uuids / pi ids / entry ids). */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/**
 * Shared secret gating the WS upgrade and `/api/*`. The dev server binds
 * `0.0.0.0` so the UI is reachable from a phone on the LAN; without this anyone
 * on the network could drive the Workshop agent (Bash = RCE). See authToken.ts.
 */
const AUTH_TOKEN = resolveAuthToken();
const portForwardGrants = new PortForwardGrantStore();

const shutdownGraceEnv = Number(process.env.ASSISTANT_SHUTDOWN_GRACE_MS);
const GRACEFUL_SHUTDOWN_TIMEOUT_MS =
  Number.isFinite(shutdownGraceEnv) && shutdownGraceEnv > 0
    ? shutdownGraceEnv
    : 55 * 60_000;
let shutdownRequested = false;

/** Both harness drivers qualify; a placeholder without a runtime does not. */
function isPromptQueueDriver(
  candidate: unknown,
): candidate is PromptQueueDriver {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "createRuntimeAdapter" in candidate &&
    "canSteer" in candidate
  );
}

function backgroundWorkHumanLink(itemId: string): string {
  return `/background-tasks?task=${encodeURIComponent(itemId)}`;
}

const backgroundCompletionDelivery = new BackgroundCompletionDelivery({
  drainPeers: (sessionId) => drainRecipient(sessionId),
  offer: async (sessionId, signal, clientRequestId) => {
    const candidate =
      hub.getLiveById(sessionId) ?? (await hub.acquireById(sessionId));
    if (
      !candidate ||
      !("createRuntimeAdapter" in candidate) ||
      !("canSteer" in candidate)
    )
      return "unavailable";
    const driver = candidate as RuntimePromptDriver;
    const origin = {
      kind: "system" as const,
      source: "background-completion" as const,
      presentation: signal.presentation,
    };
    // A running turn is an opportunity, not an obstacle, when the driver can
    // take mid-turn input: joining it delivers the same fact for the cost of a
    // message instead of a whole turn — pi's equivalent of the notification the
    // Claude CLI injects for itself. `steerOnly` means the driver decides, so a
    // turn that ended in the meantime yields `SteerNotTakenError` and this falls
    // back to "busy", which retains the batch for the next idle drain.
    if (driver.isRunning) {
      if (!driver.canSteer) return "busy";
      try {
        await promptRuntimeSession(driver, signal.visibleText, {
          origin,
          contextBlock: signal.contextBlock,
          // A DISTINCT identity from the fallback's. The steer registers this id
          // with the runtime and the pi driver before pi can reject it
          // asynchronously; sharing the key would let a failed steer answer the
          // later ordinary delivery "already handled" and drop the batch.
          clientRequestId: `${clientRequestId}:steer`,
          steer: true,
          steerOnly: true,
        });
        return "delivered";
      } catch (error) {
        if (
          error instanceof SteerNotTakenError ||
          error instanceof SessionBusyError
        )
          return "busy";
        console.warn("[background] completion steer failed:", error);
        return "busy";
      }
    }
    try {
      await backgroundCompletionTurns.run(sessionId, (accepted) =>
        promptRuntimeSession(driver, signal.visibleText, {
          origin,
          contextBlock: signal.contextBlock,
          clientRequestId,
          onUserEntry: () => accepted(),
        }),
      );
      return "delivered";
    } catch (error) {
      if (error instanceof SessionBusyError) return "busy";
      console.warn("[background] completion delivery failed:", error);
      return "unavailable";
    }
  },
  discard: (entry) => {
    const cleanupPath = entry.notice.output?.cleanupPath;
    if (cleanupPath) removeBackgroundDeliveryOutput(cleanupPath);
  },
  disposition: (notice) =>
    backgroundCompletionDisposition({
      backend: notice.backend,
      stopRequested: notice.stopRequested,
      ...(notice.stopOrigin ? { stopOrigin: notice.stopOrigin } : {}),
      ownerTurnRunning: notice.ownerTurnRunning,
    }).disposition,
});

// Deferred facts ride the next turn the session takes for any other reason.
setDeferredBackgroundContextProvider((sessionId) =>
  backgroundCompletionDelivery.peekDeferredContext(sessionId),
);

// Background work shares the existing reload/SIGTERM authority. It never joins
// the session run counter. Delivery stops with admission so an idle hook cannot
// start a fresh turn while deployment waits for runningCount() to reach zero.
hub.registerLifecycleDrainParticipant({
  closeAdmissions: () => {
    backgroundCompletionDelivery.stop();
    backgroundWorkSupervisor.closeAdmissions();
  },
  drain: () => backgroundWorkSupervisor.drain(),
});
backgroundWorkSupervisor.setOrdinaryTurnActiveHandler((ownerSessionId) => {
  const driver = hub.getLiveById(ownerSessionId);
  return backgroundCompletionTurns.protectsOrdinaryTurn(
    ownerSessionId,
    Boolean(driver?.isRunning),
  );
});
/** The card's command facts, exactly as the registry row carries them. */
function backgroundNoticeCommand(item: BackgroundWorkItem): {
  description?: string;
  command?: string;
  commandTruncated?: boolean;
} {
  return {
    ...(item.description ? { description: item.description } : {}),
    ...(item.command ? { command: item.command } : {}),
    ...(item.commandTruncated ? { commandTruncated: true } : {}),
  };
}

backgroundWorkSupervisor.setActivityRecordedHandler((item, activity) => {
  const output = writeBackgroundDeliveryOutput(
    activity.lines,
    activity.droppedEventCount,
  );
  backgroundCompletionDelivery.enqueueActivity(item.ownerSessionId, {
    itemId: item.id,
    eventId: activity.eventId,
    label: item.label,
    ...backgroundNoticeCommand(item),
    lineCount: activity.lines.length,
    bytes: activity.bytes,
    droppedEventCount: activity.droppedEventCount,
    humanLink: backgroundWorkHumanLink(item.id),
    ...(output ? { output } : {}),
  });
});
backgroundWorkSupervisor.setCompletionRecordedHandler((item) => {
  if (
    item.state !== "completed" &&
    item.state !== "failed" &&
    item.state !== "stopped" &&
    item.state !== "lost"
  )
    return;
  const retained = item.evidence?.artifactId
    ? sessionArtifactFile(item.ownerSessionId, item.evidence.artifactId)
    : undefined;
  const output = item.evidence
    ? {
        ...(retained
          ? { path: retained.path, url: retained.artifact.url }
          : {}),
        ...(item.evidence.capturedBytes !== undefined
          ? { capturedBytes: item.evidence.capturedBytes }
          : {}),
        ...(item.evidence.originalBytes !== undefined
          ? { originalBytes: item.evidence.originalBytes }
          : {}),
        ...(item.evidence.truncated !== undefined
          ? { truncated: item.evidence.truncated }
          : {}),
        ...(item.evidence.text !== undefined
          ? { text: item.evidence.text }
          : {}),
        ...(item.evidence.refusalReason
          ? { refusalReason: item.evidence.refusalReason }
          : {}),
      }
    : undefined;
  backgroundCompletionDelivery.enqueue(item.ownerSessionId, {
    itemId: item.id,
    revision: item.revision,
    label: item.label,
    ...backgroundNoticeCommand(item),
    state: item.state,
    backend: item.backend,
    stopRequested: item.stopState !== "none",
    // The supervisor's own constant, compared as a symbol, so the policy learns
    // WHO wanted the stop without either side parsing the other's prose.
    stopOrigin:
      item.terminalReason === BACKGROUND_EVENT_RATE_TERMINAL_REASON
        ? "system"
        : "requester",
    // Sampled HERE, while the terminal fact is being recorded. Asking again at
    // drain time would always answer "idle" — the queue only drains when the
    // session is idle — and the whole question is whether a turn was live to
    // receive the provider's own notification.
    ownerTurnRunning: Boolean(hub.getLiveById(item.ownerSessionId)?.isRunning),
    ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
    ...(item.outcomeSummary ? { outcomeSummary: item.outcomeSummary } : {}),
    humanLink: backgroundWorkHumanLink(item.id),
    ...(output ? { output } : {}),
  });
});

const WEBSOCKET_COMPRESSION = {
  // Browser clients advertise `permessage-deflate` automatically, but `ws` keeps
  // it disabled by default on servers. Enable it only for meaningful payloads so
  // large snapshots benefit while chat deltas and control frames stay cheap.
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  concurrencyLimit: 10,
  zlibDeflateOptions: {
    level: 3,
    memLevel: 7,
  },
} as const;

/**
 * Optional extra browser origins allowed to call the API (comma-separated). The
 * dev/LAN pattern (UI and server sharing a host/IP) is covered automatically;
 * this is an escape hatch for fronting the app behind another origin.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ASSISTANT_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

type DenyReason =
  "ok" | "unauthorized" | "forbidden-origin" | "forbidden-loopback";

/** Hostname portion of a `host:port` header, or undefined if unparseable. */
function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",")[0]?.trim() || undefined;
}

/** External origin for callback URLs, preferring proxy-forwarded request data. */
function requestPublicBaseUrl(req: IncomingMessage): string | undefined {
  const host =
    headerValue(req.headers["x-forwarded-host"]) ??
    headerValue(req.headers.host);
  if (!host) return PUBLIC_BASE_URL || undefined;
  const proto =
    headerValue(req.headers["x-forwarded-proto"]) ??
    (IS_PROD ? "https" : "http");
  try {
    const url = new URL(`${proto}://${host}`);
    return url.toString().replace(/\/$/, "");
  } catch {
    return PUBLIC_BASE_URL || undefined;
  }
}

/**
 * Defense-in-depth against drive-by CSRF from a malicious site loaded in the
 * user's browser. A missing Origin (non-browser clients, top-level navigations)
 * is allowed; the token is the real control there. Same-host and loopback
 * origins cover the dev/LAN pattern where UI `:5173` and server `:8787` share a
 * host/IP. A non-browser LAN client can forge Origin, so this is not the
 * primary control — the token is.
 */
function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1")
    return true;
  const reqHost = hostnameOf(req.headers.host);
  if (reqHost && host === reqHost) return true;
  return ALLOWED_ORIGINS.has(origin);
}

/** Extract the token from the Authorization header, x-assistant-token, or ?token=. */
function tokenFromRequest(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const t = auth.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const header = req.headers["x-assistant-token"];
  if (typeof header === "string" && header.trim()) return header.trim();
  const query = url.searchParams.get("token");
  return query ? query : undefined;
}

/** Constant-time comparison of the request token against {@link AUTH_TOKEN}. */
function hasValidToken(req: IncomingMessage, url: URL): boolean {
  const provided = tokenFromRequest(req, url);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Decide whether a request to the API/MCP surface is allowed. WHICH paths carry
 * their own credential is `apiAuthPolicy.ts`; this applies the checks.
 */
function denyReason(req: IncomingMessage, url: URL): DenyReason {
  // Preflight requests never carry credentials; answer them with CORS headers.
  if (req.method === "OPTIONS") return "ok";
  if (apiPathSkipsAuth(url.pathname)) return "ok";
  if (!isOriginAllowed(req)) return "forbidden-origin";
  if (!hasValidToken(req, url)) return "unauthorized";
  return "ok";
}

function respondAuthFailure(
  res: ServerResponse,
  req: IncomingMessage,
  reason: DenyReason,
): void {
  const status = reason === "unauthorized" ? 401 : 403;
  const error = reason === "unauthorized" ? "Unauthorized" : "Forbidden";
  res.writeHead(status, corsJsonHeaders(req));
  res.end(JSON.stringify({ error }));
}

/**
 * The whole HTTP surface. Deliberately NOT handed to `createServer` directly: a
 * rejection here would be an unhandled one, which Node turns into an uncaught
 * exception and the guard at the bottom of this file turns into
 * `process.exit(1)` — every live session going down with it. The `createServer`
 * wrapper below is the last-resort catch that answers 500 instead.
 *
 * The reachable trigger is the FIRST statement, not the API branches further
 * down: `new URL` throws on a malformed `Host`, and Node hands the listener
 * `a b`, `[::1`, `%%%`, `host:99999999` and the empty string alike. That is
 * above `denyReason`, so it needs no token — one unauthenticated request could
 * stop the server. Keep this wrapper in place before moving anything above it.
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestUrl = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `localhost:${PORT}`}`,
  );

  if (requestUrl.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (shutdownRequested) {
    res.writeHead(503, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ error: "Server is restarting" }));
    return;
  }

  const isApiSurface =
    requestUrl.pathname.startsWith("/api/") ||
    requestUrl.pathname.startsWith("/mcp/");

  // Gate the entire API + MCP surface before any handler runs.
  if (isApiSurface) {
    const reason = denyReason(req, requestUrl);
    if (reason !== "ok") {
      respondAuthFailure(res, req, reason);
      return;
    }
  }

  // Central CORS preflight. The `x-assistant-token` header makes every guarded
  // GET/POST a non-simple request, so browsers send an OPTIONS preflight first.
  // Answer it here for the whole API surface (204 + reflected CORS headers)
  // instead of per-endpoint, and never run the endpoint for an OPTIONS.
  if (isApiSurface && req.method === "OPTIONS") {
    res.writeHead(204, corsJsonHeaders(req));
    res.end();
    return;
  }

  if (requestUrl.pathname === "/api/port-forward-grants") {
    if (req.method === "POST") {
      try {
        const body = await readJsonBody<PortForwardGrantRequest>(req);
        const grant = portForwardGrants.mint(body.port);
        res.writeHead(201, {
          ...corsJsonHeaders(req),
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(grant));
      } catch (err) {
        const status = err instanceof PortForwardGrantError ? err.status : 400;
        res.writeHead(status, {
          ...corsJsonHeaders(req),
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: errorText(err) }));
      }
      return;
    }
    if (req.method === "DELETE") {
      try {
        const body = await readJsonBody<PortForwardGrantRevokeRequest>(req);
        if (typeof body.id !== "string" || !portForwardGrants.revoke(body.id)) {
          res.writeHead(404, corsJsonHeaders(req));
          res.end(JSON.stringify({ error: "Port-forward grant not found" }));
          return;
        }
        res.writeHead(204, corsJsonHeaders(req));
        res.end();
      } catch (err) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(JSON.stringify({ error: errorText(err) }));
      }
      return;
    }
    res.writeHead(405, corsJsonHeaders(req));
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/worktrees/")) {
    await handleWorktreeApi(req, res, requestUrl, corsJsonHeaders);
    return;
  }

  if (
    requestUrl.pathname === "/api/pull-requests" ||
    requestUrl.pathname.startsWith("/api/pull-requests/")
  ) {
    await handlePullRequestApi(req, res, requestUrl, corsJsonHeaders);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/knowledge/")) {
    await handleKnowledgeBaseApi(req, res, requestUrl, corsJsonHeaders);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/skills/")) {
    await handleSkillsApi(req, res, requestUrl, corsJsonHeaders);
    return;
  }

  if (requestUrl.pathname.startsWith("/api/web-push/")) {
    await handleWebPushApi(
      req,
      res,
      requestUrl,
      corsJsonHeaders,
      requestPublicBaseUrl(req),
    );
    return;
  }

  if (requestUrl.pathname.startsWith("/api/apns/")) {
    await handleApnsApi(req, res, requestUrl, corsJsonHeaders);
    return;
  }

  if (requestUrl.pathname === "/api/jira/issues") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const keys = [
      ...new Set(
        (requestUrl.searchParams.get("keys") ?? "")
          .split(",")
          .map((key) => key.trim().toUpperCase())
          .filter((key) => /^[A-Z][A-Z0-9]+-\d+$/.test(key)),
      ),
    ].slice(0, 20);
    const config = getJiraCredsIfAvailable();
    if (!config || keys.length === 0) {
      res.writeHead(200, corsJsonHeaders(req));
      res.end(
        JSON.stringify({ issues: [] } satisfies JiraLinkedIssuesResponse),
      );
      return;
    }
    try {
      const infos = await resolveJiraIssueInfos(config, keys);
      const response: JiraLinkedIssuesResponse = {
        issues: [...infos.values()].map((issue) => ({
          key: issue.key,
          summary: issue.summary,
          url: jiraIssueUrl(config.jiraHost, issue.key),
        })),
      };
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(502, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/github/issues") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const refs = normalizeGithubIssueRefs(
      (requestUrl.searchParams.get("refs") ?? "").split(","),
    ).slice(0, 20);
    const config = getGithubConfigIfAvailable();
    const response: GithubLinkedIssuesResponse = {
      issues:
        config && refs.length
          ? await resolveGithubLinkedIssues(config, refs)
          : [],
    };
    res.writeHead(200, corsJsonHeaders(req));
    res.end(JSON.stringify(response));
    return;
  }

  if (requestUrl.pathname === "/api/credential-profiles") {
    if (req.method === "GET") {
      const includeUsage = requestUrl.searchParams.get("includeUsage") === "1";
      const profiles = includeUsage
        ? listCredentialProfilesWithUsage()
        : listCredentialProfiles();
      const includeModels =
        requestUrl.searchParams.get("includeModels") === "1";
      const modelsByProfile = includeModels
        ? Object.fromEntries(
            await Promise.all(
              profiles.map(async (profile) => [
                profile.id,
                profile.provider === "claude"
                  ? getSettings().claudeSdk.enabled
                    ? CLAUDE_SDK_MODELS.map(
                        ({ sdkModelId: _sdkModelId, ...model }) => model,
                      )
                    : []
                  : await listModelsForProfile(profile.id).catch(() => []),
              ]),
            ),
          )
        : undefined;
      res.writeHead(200, corsJsonHeaders(req));
      res.end(
        JSON.stringify({
          profiles,
          ...(modelsByProfile ? { modelsByProfile } : {}),
        }),
      );
      return;
    }
    if (req.method === "POST") {
      try {
        const body = await readJsonBody<{ name?: unknown; provider?: unknown }>(
          req,
        );
        if (
          typeof body.name !== "string" ||
          (body.provider !== "openai-codex" && body.provider !== "claude")
        )
          throw new Error("A name and supported provider are required.");
        const profile = createCredentialProfile({
          name: body.name,
          provider: body.provider,
        });
        if (profile.provider === "openai-codex")
          void modelRuntimeForProfile(profile.id).catch((err) =>
            console.warn(
              `[models] credential profile ${profile.id} warm-up failed:`,
              errorText(err),
            ),
          );
        res.writeHead(201, corsJsonHeaders(req));
        res.end(JSON.stringify({ profile }));
      } catch (err) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(JSON.stringify({ error: errorText(err) }));
      }
      return;
    }
    res.writeHead(405, corsJsonHeaders(req));
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  if (
    requestUrl.pathname.match(/^\/api\/credential-profiles\/[A-Za-z0-9_-]+$/)
  ) {
    const profileId = requestUrl.pathname.split("/")[3] ?? "";
    try {
      if (req.method === "PATCH") {
        const body = await readJsonBody<{ name?: unknown; enabled?: unknown }>(
          req,
        );
        if (typeof body.enabled === "boolean") {
          res.writeHead(200, corsJsonHeaders(req));
          res.end(
            JSON.stringify({
              profile: setCredentialProfileEnabled(profileId, body.enabled),
            }),
          );
          return;
        }
        if (typeof body.name !== "string")
          throw new Error("A profile name or enabled state is required.");
        res.writeHead(200, corsJsonHeaders(req));
        res.end(
          JSON.stringify({
            profile: renameCredentialProfile(profileId, body.name),
          }),
        );
        return;
      }
      if (req.method === "DELETE") {
        // Settings pins never block deletion; they are reported and dropped so
        // no stale account id survives in the persisted settings. Cleared only
        // after the delete succeeds — it still refuses while sessions are bound.
        deleteCredentialProfile(profileId);
        const clearedSlots = await clearProfilePins(profileId);
        res.writeHead(200, corsJsonHeaders(req));
        res.end(JSON.stringify({ ok: true, clearedSlots }));
        return;
      }
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (
    requestUrl.pathname.match(
      /^\/api\/credential-profiles\/[A-Za-z0-9_-]+\/login$/,
    )
  ) {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const profileId = requestUrl.pathname.split("/")[3] ?? "";
    try {
      startOpenAiProfileLogin(profileId);
      res.writeHead(202, corsJsonHeaders(req));
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/usage/claude") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const profileId = requestUrl.searchParams.get("profileId");
      if (profileId && credentialProfileById(profileId)?.provider !== "claude")
        throw new Error("That is not a Claude credential profile.");
      // Served from the shared cache (`usageCache.ts`); `refresh=1` is the
      // Usage page's manual refresh, which bypasses freshness and writes
      // through so every open card sees the new numbers.
      const snapshot = await readUsageSnapshot(
        profileId || defaultClaudeProfileId(),
        "claude",
        { force: requestUrl.searchParams.get("refresh") === "1" },
      );
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(502, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/usage/openai") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const profileId = requestUrl.searchParams.get("profileId");
      if (
        profileId &&
        credentialProfileById(profileId)?.provider !== "openai-codex"
      )
        throw new Error("That is not an OpenAI credential profile.");
      const snapshot = await readUsageSnapshot(
        profileId || defaultOpenAiProfileId(),
        "openai-codex",
        { force: requestUrl.searchParams.get("refresh") === "1" },
      );
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(502, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/usage/openai/redeem-reset") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const body = await readJsonBody<{
        creditId?: unknown;
        profileId?: unknown;
        force?: unknown;
      }>(req);
      const creditId = typeof body.creditId === "string" ? body.creditId : "";
      if (!creditId.trim()) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(JSON.stringify({ error: "A creditId is required." }));
        return;
      }
      const profileId =
        typeof body.profileId === "string" ? body.profileId : "";
      if (
        profileId &&
        credentialProfileById(profileId)?.provider !== "openai-codex"
      )
        throw new Error("That is not an OpenAI credential profile.");
      // `force` is the user's explicit "redeem anyway" from the confirm
      // dialog: it skips the applicability guard rather than 409-ing.
      const result = await redeemOpenAiResetCreditForProfile(
        profileId || defaultOpenAiProfileId(),
        creditId,
        { requireApplicable: body.force !== true },
      );
      // A redeemed credit resets a window, so the cached percent is wrong the
      // moment this returns.
      revalidateUsage({
        force: true,
        profileIds: [profileId || defaultOpenAiProfileId()],
      });
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(result));
    } catch (err) {
      // A guarded refusal (nothing applicable to reset) is a 409, not a server error.
      const notApplicable = !!(
        err &&
        typeof err === "object" &&
        (err as { notApplicable?: boolean }).notApplicable
      );
      res.writeHead(notApplicable ? 409 : 502, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/prompt/refine") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const body = await readJsonBody<PromptRefineRequest>(req);
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(JSON.stringify({ error: "Prompt text cannot be empty." }));
        return;
      }

      let context = "";
      if (body.includeContext !== false && body.sessionId) {
        // Resolve the live session by OUR id (no kind needed); use its snapshot
        // for the visible-conversation context when it's resident.
        const snapshot = hub.getLiveById(body.sessionId)?.snapshot();
        if (snapshot) context = buildVisibleConversationContext(snapshot);
      }

      const refinedText = await refinePromptText({
        text,
        context,
        settings: getSettings().promptRefinement,
      });
      const payload: PromptRefineResponse = { refinedText };
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  /**
   * One-shot dictation fallback. The happy path streams audio over
   * `/ws/speech`, but the browser keeps the authoritative copy of the utterance
   * so it can always deliver it here instead — when the socket died mid-utterance
   * or its backlog never drained. That is why there is no resume protocol: this
   * endpoint makes one complete, retryable request sufficient.
   *
   * Body is raw little-endian signed 16-bit mono PCM; the capture rate rides on
   * `?sampleRate=` (the recognizer resamples internally).
   */
  if (requestUrl.pathname === "/api/speech/transcribe") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const settings = getSettings().speechToText;
    if (!settings.enabled) {
      res.writeHead(403, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Dictation is disabled in settings." }));
      return;
    }
    const sampleRate = Number(
      requestUrl.searchParams.get("sampleRate") ?? "16000",
    );
    if (
      !Number.isFinite(sampleRate) ||
      sampleRate < 8000 ||
      sampleRate > 48000
    ) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(
        JSON.stringify({ error: "sampleRate must be between 8000 and 48000." }),
      );
      return;
    }
    try {
      const body = await readBinaryBody(
        req,
        maxUtteranceBytes(sampleRate, settings),
      );
      const samples = pcm16ToFloat32(body);
      const result = await sttEngine.transcribe(samples, sampleRate, settings);
      const payload: SpeechTranscribeResponse = {
        text: finalizeTranscript(result.text, settings),
        audioMs: Math.round((samples.length / sampleRate) * 1000),
        decodeMs: result.decodeMs,
      };
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/calendar/events") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const from = requestUrl.searchParams.get("from") ?? "";
      const to = requestUrl.searchParams.get("to") ?? "";
      if (!from || !to) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(
          JSON.stringify({
            error: "from and to query parameters are required (RFC3339).",
          }),
        );
        return;
      }
      const payload = await getCalendarEvents({ from, to });
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/calendar/worklogs") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const from = requestUrl.searchParams.get("from") ?? "";
      const to = requestUrl.searchParams.get("to") ?? "";
      if (!from || !to) {
        res.writeHead(400, corsJsonHeaders(req));
        res.end(
          JSON.stringify({
            error: "from and to query parameters are required.",
          }),
        );
        return;
      }
      const { getCalendarWorklogs } =
        await import("./tools/tempo/tempoTools.ts");
      const payload = await getCalendarWorklogs({ from, to });
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (requestUrl.pathname === "/api/calendar/day") {
    if (req.method !== "GET") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const date = requestUrl.searchParams.get("date") ?? "";
      const payload = await getDayState(date);
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  // Deterministic day-scan collection (Daily Scanner v2 phase 1). One run per
  // day at a time; concurrent requests coalesce server-side.
  if (requestUrl.pathname === "/api/calendar/day/collect") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const date = requestUrl.searchParams.get("date") ?? "";
      const result = await runDayCollection(date);
      res.writeHead(200, corsJsonHeaders(req));
      res.end(
        JSON.stringify({
          runId: result.runId,
          date: result.date,
          commit: result.commit,
          coalesced: result.coalesced ?? false,
          manifest: result.manifest,
        }),
      );
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  // Approve/decline/cancel one day-scan Tempo proposal (phase 6 + Task 144).
  // Approve drives the serialized state machine (pending-approval → executing)
  // and the real Tempo write; decline is the user's deliberate "don't log this"
  // terminal decision; cancel is proactive invalidation. All wins only from a
  // pre-execution state.
  if (
    requestUrl.pathname === "/api/calendar/day/tempo/approve" ||
    requestUrl.pathname === "/api/calendar/day/tempo/cancel" ||
    requestUrl.pathname === "/api/calendar/day/tempo/decline"
  ) {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const rowId = requestUrl.searchParams.get("rowId") ?? "";
      if (!rowId) throw new Error("rowId is required.");
      const mod = await import("./dayScan/tempoApprove.ts");
      const result = requestUrl.pathname.endsWith("/approve")
        ? await mod.approveAndSubmitTempoRow(new KnowledgeBaseStore(), rowId)
        : requestUrl.pathname.endsWith("/decline")
          ? mod.declineTempoRow(rowId)
          : mod.cancelTempoRow(rowId);
      res.writeHead(result.ok ? 200 : 409, corsJsonHeaders(req));
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  // Separately retryable structured synthesis over the last collection's facts
  // (Daily Scanner v2 phase 4). Journaled + idempotent; a re-run reconciles.
  if (requestUrl.pathname === "/api/calendar/day/synthesize") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const date = requestUrl.searchParams.get("date") ?? "";
      const result = await runDaySynthesis(date);
      res.writeHead(result.ok ? 200 : 422, corsJsonHeaders(req));
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (
    requestUrl.pathname.startsWith("/api/google/drive/file/") &&
    requestUrl.pathname.endsWith("/preview")
  ) {
    try {
      const fileId = decodeURIComponent(
        requestUrl.pathname.slice(
          "/api/google/drive/file/".length,
          -"/preview".length,
        ),
      );
      const maxChars = Number(
        requestUrl.searchParams.get("maxChars") ?? 20_000,
      );
      const payload = await getGoogleDriveFileTextPreview(fileId, maxChars);
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  if (
    requestUrl.pathname.startsWith("/api/google/gmail/thread/") &&
    requestUrl.pathname.endsWith("/preview")
  ) {
    try {
      const threadId = decodeURIComponent(
        requestUrl.pathname.slice(
          "/api/google/gmail/thread/".length,
          -"/preview".length,
        ),
      );
      const maxChars = Number(
        requestUrl.searchParams.get("maxChars") ?? 30_000,
      );
      const payload = await getGmailThreadTextPreview(threadId, maxChars);
      res.writeHead(200, corsJsonHeaders(req));
      res.end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: errorText(err) }));
    }
    return;
  }

  // A document served under a directory-scoped grant: sandboxed, token-free,
  // and readable by its own relative subresources (directFileGrants.ts).
  if (requestUrl.pathname.startsWith(FILE_GRANT_PREFIX)) {
    await handleFileGrantRequest(req, res, requestUrl);
    return;
  }

  // Mint the grant above for one typed source. Token-gated: only the trusted
  // web client can exchange an internal identity for a public capability. The
  // server resolves that identity through the source registry/root; no client
  // filesystem path is accepted for artifact, Knowledge or worktree sources.
  if (requestUrl.pathname === "/api/file-grants") {
    if (req.method !== "POST") {
      res.writeHead(405, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const request = parseMintFileGrantRequest(
        await readJsonBody<unknown>(req),
      );
      const minted = await mintDocumentTargetGrant(request);
      res.writeHead(200, corsJsonHeaders(req));
      res.end(
        JSON.stringify({
          url: minted.url,
          expiresAt: minted.expiresAt,
          delivery: minted.delivery,
        }),
      );
    } catch (err) {
      const message = errorText(err);
      const invalid = /invalid|required|only|scope|delivery/i.test(message);
      res.writeHead(invalid ? 400 : 404, corsJsonHeaders(req));
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Any file on the host, addressed by absolute path. See directFileHttp.ts for
  // why there is no path allow-list and what the delivery rules protect.
  if (requestUrl.pathname.startsWith(DIRECT_FILE_PREFIX)) {
    await handleDirectFileRequest(req, res, requestUrl, corsHeaders(req));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/session-artifacts/")) {
    try {
      const rel = decodeURIComponent(
        requestUrl.pathname.slice("/api/session-artifacts/".length),
      );
      const root = join(DATA_DIR, "session-artifacts");
      const path = join(root, rel);
      if (!relative(root, path) || relative(root, path).startsWith(".."))
        throw new Error("Invalid artifact path.");
      const body = await readFile(path);
      res.writeHead(200, {
        "content-type": contentTypeFor(path),
        ...sessionArtifactDeliveryHeaders(path, requestUrl),
        ...corsHeaders(req),
      });
      res.end(body);
    } catch (err) {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        ...corsHeaders(req),
      });
      res.end(`Artifact not found: ${errorText(err)}`);
    }
    return;
  }

  if (requestUrl.pathname.startsWith("/api/session-image/")) {
    const segments = requestUrl.pathname
      .slice("/api/session-image/".length)
      .split("/");
    const kind = segments[0];
    const sessionId = segments[1];
    const invalid = (msg: string) => {
      res.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        ...corsHeaders(req),
      });
      res.end(msg);
    };
    const notFound = () => {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8",
        ...corsHeaders(req),
      });
      res.end("Image not found.");
    };
    if (kind !== "assistant" && kind !== "workshop" && kind !== "developer") {
      invalid("Unknown session kind.");
      return;
    }
    if (!sessionId || !isSafeId(sessionId)) {
      invalid("Invalid session id.");
      return;
    }
    const entryId = segments[2];
    const imageIndexStr = segments[3];
    if (!entryId || !isSafeId(entryId)) {
      invalid("Invalid entry id.");
      return;
    }
    const imageIndex = Number(imageIndexStr);
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex > 99) {
      invalid("Invalid image index.");
      return;
    }
    try {
      const result = await hub.resolvePiImage(
        kind,
        sessionId,
        entryId,
        imageIndex,
      );
      if (!result) {
        notFound();
        return;
      }
      res.writeHead(200, {
        "content-type": result.mimeType,
        "cache-control": "public, max-age=31536000, immutable",
        ...corsHeaders(req),
      });
      res.end(result.data);
    } catch {
      notFound();
    }
    return;
  }

  if (requestUrl.pathname === "/api/google/oauth/start") {
    try {
      res.writeHead(302, {
        location: createGoogleOAuthStartUrl(requestPublicBaseUrl(req)),
      });
      res.end();
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("google", false, errorText(err)));
    }
    return;
  }

  if (requestUrl.pathname === "/api/google/oauth/callback") {
    try {
      const result = await handleGoogleOAuthCallback(
        requestUrl.searchParams,
        requestPublicBaseUrl(req),
      );
      res.writeHead(result.ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end(oauthHtml("google", result.ok, result.message));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("google", false, errorText(err)));
    }
    return;
  }

  if (requestUrl.pathname === "/api/slack/oauth/start") {
    try {
      res.writeHead(302, {
        location: createSlackOAuthStartUrl(requestPublicBaseUrl(req)),
      });
      res.end();
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("slack", false, errorText(err)));
    }
    return;
  }

  if (requestUrl.pathname === "/api/slack/oauth/callback") {
    try {
      const result = await handleSlackOAuthCallback(
        requestUrl.searchParams,
        requestPublicBaseUrl(req),
      );
      if (result.ok) slackSocketMode.reconcile();
      res.writeHead(result.ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end(oauthHtml("slack", result.ok, result.message));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("slack", false, errorText(err)));
    }
    return;
  }

  if (requestUrl.pathname === "/api/tempo/oauth/start") {
    try {
      res.writeHead(302, {
        location: createTempoOAuthStartUrl(requestPublicBaseUrl(req)),
      });
      res.end();
    } catch (err) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("tempo", false, errorText(err)));
    }
    return;
  }

  if (requestUrl.pathname === "/api/tempo/oauth/callback") {
    try {
      const result = await handleTempoOAuthCallback(
        requestUrl.searchParams,
        requestPublicBaseUrl(req),
      );
      res.writeHead(result.ok ? 200 : 400, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end(oauthHtml("tempo", result.ok, result.message));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
      res.end(oauthHtml("tempo", false, errorText(err)));
    }
    return;
  }

  // In dev the Vite server serves the UI; the Node server is API/WS only.
  if (!IS_PROD) {
    res.writeHead(404);
    res.end("Run the web app via Vite in dev mode.");
    return;
  }

  await serveWebStatic(requestUrl.pathname, res, {
    webDist: WEB_DIST,
    authToken: AUTH_TOKEN,
  });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err: unknown) => {
    console.error("Unhandled error serving", req.method, req.url, err);
    // A handler that threw AFTER answering has already said its piece; there is
    // nothing to add to a finished response but a write-after-end.
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(500, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      // GENERIC on the wire. Every other `errorText` responder in this file
      // sits behind `denyReason`; this one can fire above it, on a request that
      // carried no token — and the errors that reach here are the ones nobody
      // shaped, so they carry filesystem paths and internals. The detail is in
      // the log line above, where it belongs.
      res.end(JSON.stringify({ error: "Internal server error" }));
      return;
    }
    res.end();
  });
});

/**
 * Four WebSocket surfaces share this HTTP server: the session protocol on `/ws`,
 * dictation audio on `/ws/speech`, official Claude CLI login on
 * `/ws/claude-login`, and binary desktop forwarding on `/ws/port-forward`.
 * They must all be `noServer` and be
 * routed by one `upgrade` listener — constructing them with `{ server, path }`
 * would attach two independent listeners, each calling `handleUpgrade`
 * unconditionally, and the one whose `path` did not match would abort the
 * handshake with 400 before the right one ever saw it.
 *
 * Speech frames are 16-bit PCM: `permessage-deflate` only reaches ~76% of
 * original on that, which is not worth the per-frame CPU, so compression stays
 * on the session socket only.
 */
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: WEBSOCKET_COMPRESSION,
});
const speechWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});
const claudeLoginWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});
const portForwardWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: PORT_FORWARD_MAX_FRAME_BYTES,
});

/** Refuse an upgrade with a real status line, as `ws` does internally. */
function abortUpgrade(
  socket: import("node:stream").Duplex,
  code: number,
  message: string,
): void {
  socket.write(
    `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  let url: URL;
  try {
    url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? `localhost:${PORT}`}`,
    );
  } catch {
    abortUpgrade(socket, 400, "Bad Request");
    return;
  }

  if (url.pathname === PORT_FORWARD_PATH) {
    if (url.search) {
      abortUpgrade(
        socket,
        400,
        "Forwarding credentials belong in Authorization",
      );
      return;
    }
    if (!isOriginAllowed(req)) {
      abortUpgrade(socket, 403, "Forbidden origin");
      return;
    }
    if (shutdownRequested || hub.isReloadQueued()) {
      abortUpgrade(socket, 503, "Server is restarting");
      return;
    }
    let lease;
    try {
      lease = portForwardGrants.claim(bearerGrant(req.headers.authorization));
    } catch (err) {
      const status = err instanceof PortForwardGrantError ? err.status : 401;
      abortUpgrade(
        socket,
        status,
        status === 429 ? "Too Many Requests" : "Unauthorized",
      );
      return;
    }
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) lease.release();
    });
    try {
      portForwardWss.handleUpgrade(req, socket, head, (ws) => {
        upgraded = true;
        portForwardWss.emit("connection", ws, req);
        attachPortForwardSocket(ws, lease);
      });
    } catch {
      lease.release();
      abortUpgrade(socket, 400, "Bad Request");
    }
    return;
  }

  const target =
    url.pathname === "/ws"
      ? wss
      : url.pathname === "/ws/speech"
        ? speechWss
        : url.pathname === "/ws/claude-login"
          ? claudeLoginWss
          : undefined;
  if (!target) {
    abortUpgrade(socket, 404, "Not Found");
    return;
  }
  // Same gate the old per-server verifyClient applied, now in one place.
  // Browsers can't set headers on a WebSocket, so the token arrives via `?token=`.
  if (!isOriginAllowed(req)) {
    abortUpgrade(socket, 403, "Forbidden origin");
    return;
  }
  if (!hasValidToken(req, url)) {
    abortUpgrade(socket, 401, "Unauthorized");
    return;
  }
  if (shutdownRequested || hub.isReloadQueued()) {
    abortUpgrade(socket, 503, "Server is restarting");
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) =>
    target.emit("connection", ws, req),
  );
});

speechWss.on("connection", (ws) => attachSpeechSocket(ws));
claudeLoginWss.on("connection", (ws, req) => attachClaudeLoginSocket(ws, req));

wss.on("connection", (ws, req) => {
  const connection = new Connection(
    ws,
    initialSessionRoute(req),
    requestPublicBaseUrl(req),
    WEB_BUILD_ID,
  );
  connection.init().catch((err) => {
    ws.send(
      JSON.stringify({
        type: "error",
        message: `Failed to start session: ${String(err)}`,
      }),
    );
  });

  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Validate at the trust boundary before dispatch: reject malformed payloads
    // with a structured error naming the offending type, rather than letting them
    // crash a handler or corrupt persisted settings.
    const result = validateClientMessage(parsed);
    if (!result.ok) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Rejected ${result.type} message: ${result.reason}`,
        }),
      );
      return;
    }
    connection.handle(result.msg).catch((err) => {
      ws.send(JSON.stringify({ type: "error", message: String(err) }));
    });
  });

  ws.on("close", () => connection.dispose());
  ws.on("error", () => connection.dispose());
});

// Dev: the supervisor signals a server/shared code change here. We reload by
// exiting cleanly once no agent run is active (see hub.requestReload); the
// supervisor respawns us and clients auto-reconnect with no mid-run kill.
if (!IS_PROD) {
  process.on("SIGUSR2", () => hub.requestReload());
}

function requestGracefulShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(
    `[assistant] ${signal} received; draining active sessions before shutdown.`,
  );
  // Stop accepting new HTTP requests and WebSocket upgrades immediately. Existing
  // sockets stay open so active turns can finish and clients can see the restart
  // banner until the process exits.
  server.close((err) => {
    if (err)
      console.warn(
        `[assistant] HTTP close during ${signal} failed:`,
        err.message,
      );
  });
  wss.close((err) => {
    if (err)
      console.warn(
        `[assistant] WebSocket close during ${signal} failed:`,
        err.message,
      );
  });
  speechWss.close((err) => {
    if (err)
      console.warn(
        `[assistant] speech WebSocket close during ${signal} failed:`,
        err.message,
      );
  });
  claudeLoginWss.close((err) => {
    if (err)
      console.warn(
        `[assistant] Claude login WebSocket close during ${signal} failed:`,
        err.message,
      );
  });
  portForwardWss.close((err) => {
    if (err)
      console.warn(
        `[assistant] port-forward WebSocket close during ${signal} failed:`,
        err.message,
      );
  });
  portForwardGrants.revokeAll();
  stopClaudeLoginTerminals();
  // Dictation and credential login are not agent turns, so the drain must not wait on them: reject new
  // utterances and let the recognizer child go. An in-flight decode is seconds at
  // most, and leaving the child alive would hand it to ExecStop's cgroup sweep.
  void sttEngine.dispose(`Server ${signal}`);
  // The package proxy is deliberately NOT stopped here: a draining agent turn
  // may still be mid-build, and killing its dependency resolution would fail
  // the turn we are waiting for. It dies with the process.
  stopSlackAssistantChat();
  stopPermanentAssistant();
  stopMemoryMaintenance();
  stopTaskAutoArchiveSweep();
  stopSessionAutoArchiveSweep();
  stopOpenAiResetAutoRedeemSweep();
  stopSlackShortcutIntake();
  slackSocketMode.stop(`Server ${signal}`);
  // Stop delivering queued peer prompts too: the idle hook keeps firing as
  // active turns finish, and re-driving idle sessions from the queue would keep
  // `runningCount()` above zero so the drain never settles (deploy hangs until
  // the force timeout). Queued rows resume on next boot via drainAllQueuedOnBoot.
  stopPeerPromptDelivery();
  // Same reason, same shape, for the card outcomes waiting on an idle edge
  // (`agentHandoffs.ts`): their rows are durable and deliver after the restart.
  stopAgentHandoffDelivery();
  // And for the user's queued messages, which wait durably for the next boot.
  stopPromptQueueDelivery();
  // A background fetch is not work worth draining for, and it is not an agent
  // turn: stop scheduling new sweeps rather than waiting one out.
  void import("./worktrees/worktreeFetch.ts")
    .then((m) => m.stopBackgroundFetch())
    .catch(() => undefined);
  stopDayCollection();
  stopDayScanSchedule();
  hub.requestGracefulShutdown({ forceAfterMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS });
}

// On deployment/systemd stop, drain instead of exiting immediately: stop new
// connections/prompts, wait for active turns to settle,
// then process.exit lets the synchronous DB close hook checkpoint SQLite.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => requestGracefulShutdown(sig));
}

// Defense-in-depth: an agent subprocess (e.g. the Claude Agent SDK's spawned
// CLI) can die mid-turn, and the SDK writes the prompt to its now-broken stdin,
// which surfaces as an unhandled EPIPE/ECONNRESET 'error' event on an internal
// socket — enough to take the whole server (every session) down. Swallow only
// that narrow write-failure case so the affected turn fails on its own while the
// server stays up; re-crash on anything else to preserve default behavior.
process.on("uncaughtException", (err) => {
  const e = err as NodeJS.ErrnoException;
  if (
    (e?.code === "EPIPE" || e?.code === "ECONNRESET") &&
    e?.syscall === "write"
  ) {
    console.error(
      "Ignoring write error from a dead agent subprocess:",
      e.message,
    );
    return;
  }
  console.error("Uncaught exception:", err);
  process.exit(1);
});

// Flush + close the SQLite handle cleanly on any exit (Ctrl-C, SIGTERM, dev
// reload). Synchronous work only, which is exactly what `process.on("exit")`
// allows and what node:sqlite needs. The DATA_DIR lock goes last, once nothing
// of this process can write there any more.
process.on("exit", () => {
  closeDb();
  serverBootLock.release();
});

// Before binding: every file outside Bun's embedded module tree must exist in
// the explicit runtime root. Prompt validation then checks the tracked persona
// inventory and content, rather than mere file presence.
assertPackagedRuntimeAssets();
assertPromptAssets();

// Every constant these variables feed (DATA_DIR, HOST/PORT, AUTH_TOKEN,
// ALLOWED_ORIGINS, build stamp and core integration credentials) has been
// captured. Drop them before the first startup subprocess so neither host-tool
// probes nor a development build's git query inherits this instance's identity.
const scrubbed = scrubInstanceEnvironment();
if (scrubbed.length > 0)
  console.log(
    `[assistant] instance environment scrubbed for spawned agents: ${scrubbed.join(", ")}`,
  );

// Start the spawn broker while this process is still small: its own start is
// the last fork of the server that anything pays for, and it must come after
// the scrub so the helper does not carry this instance's identity either.
startSpawnBroker();
// The unit keeps this process the OOM killer's last victim; hand every agent
// process, and the broker, back the neutral score they inherited away.
startChildOomScoreRelease();
console.info(memoryLogLine());
startMemoryLog();

// The packaged stamp was captured when buildInfo.ts loaded. After the scrub, a
// development checkout may safely ask git for its build identity.
const SERVER_BUILD = serverBuildInfo();

// The agent toolchain is the HOST's, not vendored, so the declared floors in
// config/host-tools.json are checked once here. Failing the boot is the point: a
// missing `bash` would otherwise show up inside somebody's first agent turn.
verifyRequiredHostTools();

// pi's grep/find resolve rg/fd on every call and fork this server to probe PATH
// unless its bin dir already holds them; link the host's copies there once.
linkPiToolBinaries();

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(
    `[assistant] build ${formatBuildInfo(SERVER_BUILD)} (reported to clients on ready)`,
  );
  console.log(`[assistant] server listening on http://${displayHost}:${PORT}`);
  console.log(
    `[assistant] websocket on ws://${displayHost}:${PORT}/ws (permessage-deflate enabled for payloads >= ${WEBSOCKET_COMPRESSION.threshold} bytes)`,
  );
  if (!IS_PROD && displayHost === "localhost") {
    console.log(
      `[assistant] dev network access enabled — use http://<this-machine-ip>:${PORT} for API/WebSocket`,
    );
  }
  if (!IS_PROD)
    console.log(
      "[assistant] dev mode — start the web UI with the Vite dev server",
    );
  console.log(authTokenStartupMessage());
  try {
    const recovered = reconcileMissingPiSessionMetadata();
    if (recovered > 0)
      console.log(
        `[assistant] recovered ${recovered} pi session metadata row(s) from native transcripts`,
      );
  } catch (err) {
    console.warn(
      "[assistant] session metadata recovery failed:",
      errorText(err),
    );
  }
  registerPdfClaudeFallback();
  void warmCredentialProfileModelRuntimes().catch((err) =>
    console.warn("[models] credential profile warm-up failed:", errorText(err)),
  );
  // Turns runtime events into the Sessions inbox's run-start / failure /
  // settlement-reactivation facts for every harness at once.
  installSessionActivityTracking();
  // Publishes proxy/CA env vars to `childProcessEnv()` (never process.env), so
  // every later-spawned agent, host command and build tool gets them while the
  // server's own traffic stays direct. Best-effort: a failure here must
  // never stop the server from serving.
  void startPackageProxyIfEnabled()
    .then((status) => {
      if (status.running)
        console.log(
          `[package-proxy] ready on ${status.url} (${status.hosts?.join(", ")})`,
        );
      else
        console.log(
          `[package-proxy] not running: ${status.reason ?? "disabled"}`,
        );
    })
    .catch((err) =>
      console.warn("[package-proxy] start failed:", errorText(err)),
    );
  startMemoryMaintenance();
  // Day-scan synthesis: wire the live runner model and reconcile any run left
  // non-terminal by a crash (resume-not-duplicate; the candidate→Task map is unique).
  void import("./dayScan/synthesisModel.ts")
    .then((m) => m.installDaySynthesizer())
    .catch((err) =>
      console.warn("[day-scan] synthesizer install failed:", errorText(err)),
    );
  // Day-scan minutes: wire the live Google discovery/extraction pipeline (null when unconfigured).
  void import("./dayScan/minutesPipeline.ts")
    .then((m) => m.installMinutesPipeline())
    .catch((err) =>
      console.warn(
        "[day-scan] minutes pipeline install failed:",
        errorText(err),
      ),
    );
  void import("./dayScan/synthesisApply.ts")
    .then((m) => m.reconcileDaySynthesisOnStartup(new KnowledgeBaseStore()))
    .then((closed) => {
      if (closed.length > 0)
        console.log(
          `[day-scan] reconciled ${closed.length} synthesis run(s) on boot`,
        );
    })
    .catch((err) =>
      console.warn(
        "[day-scan] synthesis boot reconcile failed:",
        errorText(err),
      ),
    );
  // Scheduled morning collection (+ optional synthesis) so the prep view is
  // ready before the day starts; a no-op until enabled in day-scan settings.
  startDayScanSchedule();
  /**
   * The credential profile whose usage a finished run consumed. Sessions
   * created before the account was chosen carry no binding, so fall back to the
   * account automatic work runs on for that harness's provider.
   */
  const usageProfileForSession = (sessionId: string): string | null => {
    const session = sessionStore.get(sessionId);
    if (!session) return null;
    if (session.credentialProfileId) return session.credentialProfileId;
    return session.harness === "claude-sdk"
      ? defaultClaudeProfileId()
      : defaultOpenAiProfileId();
  };
  // Declarative Web Push is driven by a real normalized run completion, not a
  // generic idle transition or synthetic host command.
  subscribeSessionRunCompleted((sessionId, stopReason, origin) => {
    void notifySessionTurnCompleted(sessionId, stopReason, {
      ...(origin ? { origin } : {}),
    }).catch((err) => {
      console.warn(
        "[web-push] session completion notification failed:",
        errorText(err),
      );
    });
    // A finished run moved this account's usage. The run completion is the only
    // trigger we take (a session's last turn IS one, and the idle hook is a
    // superset that would double-fetch); it only marks the account dirty.
    const profileId = usageProfileForSession(sessionId);
    if (profileId) markUsageProfileDirty(profileId);
  });
  // Each boot recovery is its own step: one that throws (a corrupt row) must
  // not skip every recovery after it.
  bootStep("interrupted-run marking", () => {
    // Which sessions hold a turn the process died inside. Every harness flushes a
    // turn's assistant entry and tool results together at completion, so a killed
    // turn leaves NO transcript and the session reads as idle and healthy; the
    // run bracket in its log is the only evidence, and this is the one moment it
    // can be read honestly (nothing is live yet, so an open bracket cannot be a
    // turn that is merely still going).
    const interrupted = markInterruptedRunsOnBoot();
    if (interrupted > 0)
      console.log(
        `[assistant] ${interrupted} session(s) hold a turn cut off by the previous exit`,
      );
  });
  bootStep("peer-prompt recovery", () => {
    const recovered = recoverPeerPromptsOnBoot();
    if (recovered.recovered > 0)
      console.log(
        `[assistant] recovered ${recovered.recovered} in-flight peer prompt(s) (${recovered.interrupted} interrupted after prior admission)`,
      );
  });
  bootStep("background-work reconciliation", () => {
    // No background command or monitor survives an OS process restart, so
    // anything a previous epoch left nonterminal is lost. Never replayed.
    const sweptProviderTemps = sweepBackgroundTaskOutputTemps();
    if (sweptProviderTemps > 0)
      console.log(
        `[background] removed ${sweptProviderTemps} abandoned provider temp tree(s)`,
      );
    const background = reconcileBackgroundWorkOnBoot();
    if (background.items > 0 || background.hosts > 0)
      console.log(
        `[background] marked ${background.items} work item(s) and ${background.hosts} host epoch(s) lost from a previous process`,
      );
    const deleted = tombstoneDeletedOwnersOnBoot();
    if (deleted.items > 0)
      console.log(
        `[background] tombstoned ${deleted.items} work item(s) of ${deleted.owners} deleted session(s)`,
      );
    if (deleted.blockedOwners > 0)
      console.warn(
        `[background] ${deleted.blockedOwners} deleted session(s) still own live background work; left as members`,
      );
  });
  setPromptQueueHost({
    resolve: async (sessionId) => {
      const live =
        hub.getLiveById(sessionId) ?? (await hub.acquireById(sessionId));
      return isPromptQueueDriver(live) ? live : undefined;
    },
    live: (sessionId) => {
      const live = hub.getLiveById(sessionId);
      return isPromptQueueDriver(live) ? live : undefined;
    },
    publish: (sessionId, queue) => hub.broadcastPromptQueue(sessionId, queue),
    reportError: (sessionId, message) =>
      hub.reportSessionError(sessionId, message),
    // The idle chain's tail. `BackgroundCompletionDelivery.drain` runs its
    // `drainPeers` (the peer FIFO) first and then offers background
    // completions, which is exactly what waited behind the queue.
    yieldToOthers: (sessionId) =>
      void backgroundCompletionDelivery.requestDrain(sessionId),
  });
  setHumanPromptHook(
    humanPromptHandler({
      closeChains: closeChainsForHumanPrompt,
      broadcastSessions: () => void hub.broadcastSessions(),
    }),
  );
  // A card outcome the user decided while this session was mid-turn takes the
  // edge FIRST: it is the one thing waiting here that the agent may be
  // BLOCKED on, and the user is watching for it. Both harness adapters
  // publish this edge only after their provider primitive has settled, so
  // delivery can start immediately without steering or being claimed by the
  // prior turn.
  //
  // The user's own queued messages come next (`promptQueue.ts`): they are
  // what the user asked to happen after this turn, ahead of anything an agent
  // queued. The peer FIFO then owns the first edge with neither owed, and
  // background completion is offered only after the peer drain finishes.
  // Ordering them rather than racing them is what keeps that true: each
  // treats a session that has started running as "not now", so a handoff that
  // wins an unordered race would make the other two wait for a turn they
  // could have gone first in — and the reverse would leave the user's
  // decision behind another agent's message.
  //
  // BOOT is deliberately not sequenced this tightly (see below): both
  // recoveries start their own async work, so a peer prompt can still win the
  // first turn there. The cost is one turn of ordering for a session that
  // happens to owe both, and paying for it would mean holding every other
  // session's peer delivery behind a handoff turn that can run for minutes.
  setSessionIdleHook((sessionId) => {
    // Cards a session grant approves run first: each queues its outcome as a
    // handoff, so the drain below carries it to the agent in order.
    void runAutoApprovals(sessionId)
      .catch(() => {})
      .then(() => drainAgentHandoffs(sessionId))
      .catch(() => {})
      .then(() => drainPromptQueue(sessionId))
      .catch(() => {})
      .then(() => {
        void backgroundCompletionDelivery.drain(sessionId);
      });
  });
  // Offered in the same order as the idle edge, though only offered: both
  // calls return once their per-session work is in flight, so this is a
  // priority, not a sequence (see the idle hook above).
  bootStep("auto-approval recovery", () => recoverAutoApprovalsOnBoot());
  bootStep("agent-handoff recovery", () => recoverAgentHandoffsOnBoot());
  bootStep("prompt-queue drain", () => drainPromptQueuesOnBoot());
  bootStep("peer-prompt drain", () => drainAllQueuedOnBoot());
  bootStep("peer-prompt retention", () => runPeerPromptRetention());
  void sweepMainWorktreeCommentRetention().catch((err) =>
    console.warn(
      "[worktrees] main-checkout comment retention sweep failed:",
      errorText(err),
    ),
  );
  setInterval(
    () => {
      try {
        runPeerPromptRetention();
      } catch (err) {
        console.warn("[peer-prompt] retention sweep failed:", errorText(err));
      }
      void sweepMainWorktreeCommentRetention().catch((err) =>
        console.warn(
          "[worktrees] main-checkout comment retention sweep failed:",
          errorText(err),
        ),
      );
    },
    24 * 60 * 60 * 1000,
  ).unref();
  // The retry/lease sweeps are the ONLY path back from retryable_failed and
  // an expired dispatch lease respectively — without this interval those
  // rows would never recover in a running server. Run once at boot too.
  bootStep("peer-prompt retry sweep", () => sweepPeerPromptRetries());
  bootStep("dispatch-lease sweep", () => sweepExpiredLeases());
  setInterval(() => {
    try {
      sweepPeerPromptRetries();
    } catch (err) {
      console.warn("[peer-prompt] retry sweep failed:", errorText(err));
    }
    try {
      sweepExpiredLeases();
    } catch (err) {
      console.warn("[peer-prompt] lease sweep failed:", errorText(err));
    }
  }, RETRY_SWEEP_INTERVAL_MS).unref();
  startPermanentAssistant();
  startTaskAutoArchiveSweep();
  startSessionAutoArchiveSweep();
  startOpenAiResetAutoRedeemSweep();
  // Socket Mode is outbound-only, so Slack shortcuts/events work behind Tailscale.
  startSlackShortcutIntake();
  startSlackAssistantChat();
  slackSocketMode.start();
  // Start the always-on git-state watchers for every registered worktree, and
  // rescan a viewed worktree after each tool call of a session linked to it.
  void import("./worktrees/worktreeWatcher.ts")
    .then((m) => {
      subscribeSessionToolCompleted(m.rescanSessionWorktree);
      return m.rehydrateWorktreeWatchers();
    })
    .catch((err) =>
      console.warn("[worktrees] watcher rehydrate failed:", errorText(err)),
    );
  // Keep remote-tracking refs current for the repos someone is looking at, so
  // the `behind` counts a worktree reports are answers rather than guesses.
  // A no-op unless this instance is the one configured to fetch.
  void import("./worktrees/worktreeFetch.ts")
    .then((m) => m.startBackgroundFetch())
    .catch((err) =>
      console.warn(
        "[worktrees] background fetch start failed:",
        errorText(err),
      ),
    );
  // Restore any merge that was mid-conflict when the server restarted.
  void import("./worktrees/worktreeMerge.ts")
    .then((m) => m.reconcileWorktreeMergesOnBoot())
    .catch((err) =>
      console.warn("[worktrees] merge reconcile failed:", errorText(err)),
    );
  // Observe live `/pr` cards' CI/review/mergeability without needing a viewer,
  // and release any card action the previous process died in the middle of.
  void import("./pullRequestActions.ts")
    .then((m) => m.reconcilePullRequestCardActionsOnBoot())
    .catch((err) =>
      console.warn("[pull-requests] action reconcile failed:", errorText(err)),
    );
  void import("./pullRequestWatcher.ts")
    .then((m) => {
      m.startPullRequestWatcher();
      return m.reconcilePullRequestCardsOnBoot();
    })
    .catch((err) =>
      console.warn("[pull-requests] watcher start failed:", errorText(err)),
    );
  // Keep the sidebar inventory current even when no browser has that view open.
  // Its HTTP endpoint serves only the persisted snapshot written by this loop.
  void import("./pullRequestInventorySync.ts")
    .then((m) => m.startPullRequestInventorySync())
    .catch((err) =>
      console.warn(
        "[pull-requests] inventory sync start failed:",
        errorText(err),
      ),
    );
  // Register every executor BEFORE reconciliation can re-dispatch a pending
  // reservation or retry a running retry-safe host operation left by a crash.
  void Promise.all([
    import("./workflow/agentExecutor.ts"),
    import("./workflow/commitSyncOperation.ts"),
    import("./workflow/deliveryOperations.ts"),
    import("./workflow/pullRequestObservation.ts"),
  ])
    .then(async ([agent, commitSync, delivery, observation]) => {
      agent.registerWorkflowAgentExecutorRuntime();
      commitSync.registerCommitSyncOperationRuntime();
      delivery.registerDeliveryOperationsRuntime();
      observation.registerPullRequestObservationRuntime();
      await observation.reconcilePullRequestObservationsOnBoot();
    })
    // Then decide what each open Workflow Run may resume: re-dispatch pending
    // reservations, adopt surviving agent steps, and pause unsafe work.
    .then(() => import("./workflow/engine.ts"))
    .then((m) => m.reconcileWorkflowRunsOnBoot())
    // Runs that completed before their sessions were shelved — or before this
    // rule existed — leave the inbox now. Last, so a run this boot just drove to
    // completion is included.
    .then(() => settleCompletedWorkflowRunSessionsOnBoot())
    .catch((err) =>
      console.warn("[workflow] run reconcile failed:", errorText(err)),
    );
});

function initialSessionRoute(
  req: IncomingMessage,
): { sessionId: string; timelineCache?: TimelineCacheDescriptor } | undefined {
  try {
    const requestUrl = new URL(
      req.url ?? "/ws",
      `http://${req.headers.host ?? `localhost:${PORT}`}`,
    );
    const sessionId = requestUrl.searchParams.get("sessionId")?.trim();
    if (!sessionId) return undefined;
    const timelineCache = timelineCacheFromQuery(requestUrl.searchParams);
    return { sessionId, ...(timelineCache ? { timelineCache } : {}) };
  } catch {
    // Best-effort route hint only; fall back to the default fresh session.
  }
  return undefined;
}

function timelineCacheFromQuery(
  params: URLSearchParams,
): TimelineCacheDescriptor | undefined {
  const projectionVersion = Number(params.get("tlv"));
  const startIndex = Number(params.get("tlst"));
  const entryCount = Number(params.get("tlc"));
  const lastEntryId = params.get("tlid")?.trim();
  const lastEntrySeq = Number(params.get("tls"));
  const fingerprint = params.get("tlf")?.trim();
  if (
    !Number.isInteger(projectionVersion) ||
    projectionVersion < 1 ||
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    !Number.isInteger(entryCount) ||
    entryCount < 1 ||
    !lastEntryId ||
    !isSafeId(lastEntryId) ||
    !Number.isInteger(lastEntrySeq) ||
    lastEntrySeq < 0 ||
    !fingerprint ||
    fingerprint.length > 64
  )
    return undefined;
  return {
    projectionVersion,
    startIndex,
    entryCount,
    lastEntryId,
    lastEntrySeq,
    fingerprint,
  };
}

function corsJsonHeaders(
  req: IncomingMessage,
  statusHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(req),
    ...statusHeaders,
  };
}

/**
 * CORS headers that reflect the request's Origin when it is allowed (instead of
 * the old `*`), so credentials/tokens stay scoped to trusted origins. A missing
 * or rejected Origin gets no `access-control-allow-origin` — browser CORS then
 * blocks it, while the guard has already rejected the rejected case.
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const base: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "content-type, x-assistant-token, authorization",
    vary: "Origin",
  };
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(req))
    base["access-control-allow-origin"] = origin;
  return base;
}

/** Collect a raw binary request body, refusing anything over `maxBytes`. */
function readBinaryBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.length > 70_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as T);
      } catch {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function oauthHtml(
  provider: "google" | "slack" | "tempo",
  ok: boolean,
  message: string,
): string {
  const label =
    provider === "google"
      ? "Google Workspace"
      : provider === "tempo"
        ? "Tempo"
        : "Slack";
  const title = ok ? `${label} connected` : `${label} connection failed`;
  const color = ok ? "#16a34a" : "#dc2626";
  const messageType =
    provider === "google"
      ? "assistantGoogleOAuthComplete"
      : provider === "tempo"
        ? "assistantTempoOAuthComplete"
        : "assistantSlackOAuthComplete";
  const payload = JSON.stringify({ type: messageType, ok });
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font:14px system-ui;margin:2rem;line-height:1.45"><h1 style="color:${color};font-size:18px">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this tab and return to Pandeck settings.</p><script>if(window.opener){window.opener.postMessage(${payload},"*");setTimeout(()=>window.close(),1200);}</script></body>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch,
  );
}
