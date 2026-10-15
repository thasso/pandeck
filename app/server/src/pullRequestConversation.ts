/**
 * `GET /api/pull-requests/conversation` — one pull request's description,
 * conversation, review threads and head checks, for its detail page.
 *
 * A LIVE read, unlike the inventory: a list poll has no use for bodies, so
 * this is asked only by a mounted detail page. Two provider reads, each with
 * its own failure — the conversation (which also reports the current head),
 * then that head's checks — so an outage of one never hides the other's answer.
 * Answers are cached briefly per pull request with in-flight coalescing; an
 * explicit refresh skips the cache.
 */
import type {
  PullRequestCheck,
  PullRequestCheckTone,
  PullRequestConversationResponse,
  PullRequestViewCheckRequest,
} from "@assistant/shared";
import { errorText } from "./errors.ts";
import type { GitHostingCheck, GitHostingProvider } from "./gitHosting.ts";
import {
  isFailedGitCheckStatus,
  isTerminalGitCheckStatus,
} from "./gitCheckStatus.ts";
import { resolvePullRequestProvider } from "./pullRequestViewMerge.ts";

const CACHE_MS = 30_000;
const SUMMARY_CHARS = 160;

const cache = new Map<
  string,
  { at: number; value: PullRequestConversationResponse }
>();
const inFlight = new Map<string, Promise<PullRequestConversationResponse>>();

function cacheKey(request: PullRequestViewCheckRequest): string {
  return `${request.projectId}#${request.provider}#${request.repositoryKey}#${request.number}`;
}

export async function readPullRequestConversation(
  request: PullRequestViewCheckRequest,
  options: { fresh?: boolean } = {},
): Promise<PullRequestConversationResponse> {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS)
    return cached.value;
  const running = inFlight.get(key);
  if (running) return running;
  const read = (async () => {
    const { provider } = await resolvePullRequestProvider(request);
    const value = await conversationOf(provider, request.number);
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, read);
  return read;
}

async function conversationOf(
  provider: GitHostingProvider,
  number: number,
): Promise<PullRequestConversationResponse> {
  const errors: { conversation?: string; checks?: string } = {};
  let response: PullRequestConversationResponse = {
    number,
    fetchedAt: Date.now(),
  };
  let headSha: string | undefined;
  try {
    const talk = await provider.pullRequestConversation(number);
    headSha = talk.headSha;
    response = {
      ...response,
      body: talk.body,
      ...(talk.author ? { author: talk.author } : {}),
      ...(talk.createdAt ? { createdAt: talk.createdAt } : {}),
      assignees: talk.assignees,
      requestedReviewers: talk.requestedReviewers,
      timeline: talk.timeline,
      ...(talk.timelineTruncated ? { timelineTruncated: true } : {}),
      threads: talk.threads,
      ...(talk.threadsTotal !== undefined
        ? { threadsTotal: talk.threadsTotal }
        : {}),
    };
  } catch (err) {
    errors.conversation = `The conversation could not be read: ${errorText(err)}`;
  }
  if (!headSha) {
    // The head comes with the conversation; without it there is nothing to
    // ask the checks API about, so the detail read supplies it.
    try {
      headSha = (await provider.pullRequestDetail(number))?.headSha;
    } catch {
      // Stated below as the checks' own failure.
    }
  }
  if (headSha) {
    try {
      const checks = await provider.refChecks(headSha);
      response.checks = {
        headSha,
        state: checks.state,
        items: checks.checks.map(checkOf),
        ...(checks.total !== undefined && checks.total > checks.checks.length
          ? { total: checks.total }
          : {}),
      };
    } catch (err) {
      errors.checks = `The checks could not be read: ${errorText(err)}`;
    }
  } else {
    errors.checks = "The checks could not be read: the head commit is unknown.";
  }
  return Object.keys(errors).length > 0 ? { ...response, errors } : response;
}

function toneOf(status: string): PullRequestCheckTone {
  const value = status.toLowerCase();
  if (value === "success") return "success";
  if (value === "skipped") return "skipped";
  if (isFailedGitCheckStatus(value)) return "failure";
  if (!isTerminalGitCheckStatus(value)) return "pending";
  return "neutral";
}

function checkOf(check: GitHostingCheck): PullRequestCheck {
  const summary = check.excerpt
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, SUMMARY_CHARS);
  return {
    name: check.name,
    tone: toneOf(check.status),
    status: check.status,
    ...(summary ? { summary } : {}),
    ...(check.url ? { url: check.url } : {}),
  };
}
