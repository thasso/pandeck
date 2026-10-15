import { useCallback, useEffect, useRef } from "react";
import type {
  PullRequestConversationResponse,
  PullRequestInventoryItem,
} from "@assistant/shared";
import { fetchPullRequestConversation } from "../lib/pullRequestsApi.ts";
import {
  pullRequestRowId,
  type PullRequestTarget,
} from "../lib/pullRequestInbox.ts";
import { useFetchState, type FetchStateResult } from "./useFetchState.ts";

/**
 * @hook usePullRequestConversation
 * @purpose The detail page's second read: one pull request's description,
 * conversation, review threads and head checks
 * (`GET /api/pull-requests/conversation`).
 * @useWhen A pull request detail page is mounted.
 * @avoidWhen Anything the inventory already carries — this read is per pull
 * request and live, so a list must never trigger it.
 * @intent Keyed by the pull request's four-component identity, so another pull
 * request gets its own placeholder (R3). It follows the inventory: when the
 * inventory reports a new head, a newer `updatedAt` or a different CI summary,
 * something happened on the provider and the conversation is read again,
 * keeping what is on screen (R2). CI is part of that because a check finishing
 * does not move the pull request's `updatedAt`. Those reads and an explicit
 * reload skip the server's short cache: the change is already known, so a
 * cached answer from before it would be consumed with no later retry.
 */
export function usePullRequestConversation(
  target: PullRequestTarget,
  item: PullRequestInventoryItem | null,
): FetchStateResult<PullRequestConversationResponse> {
  const fresh = useRef(false);
  const key = `${target.projectId}#${target.provider}#${target.repositoryKey}#${target.number}`;
  const result = useFetchState(key, (_key, signal) => {
    const skipCache = fresh.current;
    fresh.current = false;
    return fetchPullRequestConversation(target, {
      fresh: skipCache,
      signal,
    });
  });
  const { reload } = result;

  // What the inventory knows changed on the provider. The first value is the
  // one the initial read already answered.
  const revision =
    item && pullRequestRowId(item) === key
      ? `${item.headSha ?? ""}@${item.updatedAt ?? ""}#${item.ci?.state ?? ""}/${item.ci?.total ?? ""}`
      : undefined;
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === undefined) return;
    if (seen.current === undefined) {
      seen.current = revision;
      return;
    }
    if (seen.current === revision) return;
    seen.current = revision;
    fresh.current = true;
    reload();
  }, [revision, reload]);

  const reloadFresh = useCallback(() => {
    fresh.current = true;
    reload();
  }, [reload]);
  return { state: result.state, reload: reloadFresh };
}
