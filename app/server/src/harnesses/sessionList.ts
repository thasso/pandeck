/**
 * The merged session list across both engines (`docs/agent-harnesses.md`):
 * pi's live sessions overlay the stored rows (`sessions.ts`), and the Claude
 * SDK's in-process sessions join as a live source of their own. The hub owns
 * when the list is rebuilt and who hears it; this owns what it holds.
 */
import { claudeSdkStore } from "../claudeSdk/claudeSdkStore.ts";
import { sessionStore } from "../db/sessionStore.ts";
import { pendingApprovalSessionIds } from "../pendingApprovals.ts";
import { piStore } from "../piSdk/piStore.ts";
import { choosingTaskSessionIds } from "../pullRequestCards.ts";
import { sessionRuntime } from "../session/runtimeInstance.ts";
import { listSessions, type SessionListOptions } from "../sessions.ts";

const SESSION_LIST_SLOW_MS = 50;

/** Every listed session, newest first, across both engines. */
export async function mergedSessionList(
  opts: SessionListOptions = {},
): Promise<Awaited<ReturnType<typeof listSessions>>> {
  const startedAt = Date.now();
  const live = piStore.listInfo();
  const merged = await listSessions(live, sessionStore.getReadAt, opts);
  const byId = new Map(merged.map((session, index) => [session.id, index]));
  // One query each against the approval and pull-request-card tables for the
  // whole merge, never one per SDK row (`sessions.ts`'s one-pass contract).
  const approvals = pendingApprovalSessionIds();
  const taskChoices = choosingTaskSessionIds();
  // In-process SDK sessions are a live source like the pi store: they carry
  // no scope of their own, so the persisted classification decides whether
  // they may appear at all.
  const onlyIds = opts.onlyIds;
  const sdkSessions = claudeSdkStore
    .list()
    .filter((sdk) => !onlyIds || onlyIds.has(sdk.id));
  const sdkAllowed = sessionStore.liveDefaultScopeGate(
    sdkSessions.map((sdk) => sdk.id),
    { includeArchived: Boolean(opts.includeArchived) },
  );
  for (const sdk of sdkSessions) {
    const sdkKey = sdk.id;
    if (!sdkAllowed(sdkKey)) continue;
    const item = sdk.listItem(
      sessionStore.getReadAt(sdkKey),
      approvals,
      taskChoices,
    );
    // Match the pi projection: acquiring a runtime claims metadata but does
    // not create a conversation. Claude prompts persist + invalidate at user
    // entry acceptance, so a real first turn appears immediately.
    if (item.messageCount === 0) continue;
    item.isStreaming =
      sessionRuntime.isRunning(sdkKey) || Boolean(item.isStreaming);
    if (sessionStore.isArchived(sdkKey)) item.archived = true;
    if (item.archived && !opts.includeArchived) continue;
    const idx = byId.get(item.id);
    if (idx === undefined) {
      byId.set(item.id, merged.length);
      merged.push(item);
    } else {
      merged[idx] = { ...merged[idx], ...item };
    }
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  const elapsed = Date.now() - startedAt;
  if (elapsed > SESSION_LIST_SLOW_MS && process.env.NODE_ENV !== "production") {
    console.debug(
      `[perf] session list generated in ${elapsed}ms (${merged.length} sessions)`,
    );
  }
  return merged;
}
