import {
  jsonResult,
  type ToolCallContext,
  type ToolResult,
} from "../mcp/tool.ts";
import { launchServerTask } from "../serverTasks.ts";
import {
  checkWaitBounds,
  checkWaitSummary,
  checksAreFinished,
  continueCheckWatch,
  pollCheckWatch,
  startCheckWatch,
  throwIfAborted,
  type CheckObservation,
  type WatchOutcome,
} from "./pullRequestCheckWatch.ts";

export type RefCheckWaitParams = {
  wait?: boolean;
  background?: boolean;
  timeoutSeconds?: number;
  pollIntervalSeconds?: number;
};

/** Shared schema prose; bounds and stop rules come from the PR watch itself. */
export function refCheckWaitParameters(provider: "GitHub" | "Forgejo") {
  return {
    wait: {
      type: "boolean",
      description:
        "Wait for checks to appear and finish; defaults to false, one current snapshot. A branch ref follows new pushes. Stops on finished or truncated checks, timeout, or no_checks after 120 seconds without checks on one head. GitHub also stops on a low rate-limit budget. The payload state stays the provider's raw state.",
    },
    background: {
      type: "boolean",
      description:
        "Wait as PA background work instead of blocking this turn; implies wait. Returns a taskId at once, or the result when the first observation ends the wait. The final JSON arrives automatically and is kept as its output file. Ending your turn does not stop it; background_tasks stop does. Bounded by the Settings background lifetime, default 60 minutes, which shortens a longer timeoutSeconds. Only an interactive top-level session may start one.",
    },
    timeoutSeconds: {
      type: "number",
      description:
        "Maximum wait time: default 1800 seconds, minimum 30, maximum 7200. Timeout returns the latest snapshot rather than throwing.",
    },
    pollIntervalSeconds: {
      type: "number",
      description: `Polling interval: default ${provider === "GitHub" ? 60 : 15} seconds, minimum ${provider === "GitHub" ? 30 : 5}, maximum 120.`,
    },
  };
}

/** Keep the two providers' compact current output and wait lifecycle aligned. */
export async function executeRefCheckWait<Summary>(
  params: RefCheckWaitParams,
  ctx: ToolCallContext,
  options: {
    toolName: string;
    providerName: "GitHub" | "Forgejo";
    repo: string;
    ref: string;
    read(signal: AbortSignal | undefined): Promise<Summary>;
    observe(summary: Summary): Omit<CheckObservation<Summary>, "snapshot">;
    payload(
      summary: Summary,
      signal: AbortSignal | undefined,
    ): Promise<Record<string, unknown>> | Record<string, unknown>;
  },
): Promise<ToolResult> {
  const bounds = checkWaitBounds(options.providerName, params);
  const compactResult = (payload: Record<string, unknown>): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  });
  if (!bounds.wait) {
    const summary = await options.read(ctx.signal);
    return compactResult(await options.payload(summary, ctx.signal));
  }
  const watch = startCheckWatch();
  const observe = (signal: AbortSignal | undefined) => async () => {
    const snapshot = await options.read(signal);
    return { snapshot, ...options.observe(snapshot) };
  };
  const report = async (
    outcome: WatchOutcome<Summary>,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) => {
    const observation = options.observe(outcome.snapshot);
    return {
      ...(await options.payload(outcome.snapshot, signal)),
      finished: checksAreFinished(observation.checks),
      observation: {
        mode: bounds.mode,
        stopReason: outcome.stopReason,
        polls: outcome.polls,
        elapsedSeconds: Math.round(outcome.elapsedMs / 100) / 10,
        timeoutSeconds: timeoutMs / 1_000,
        pollIntervalSeconds: bounds.pollIntervalSeconds,
        headSha: observation.headSha,
        ...(outcome.rateLimitRemaining !== undefined
          ? { rateLimitRemaining: outcome.rateLimitRemaining }
          : {}),
      },
    };
  };
  if (!bounds.background) {
    const outcome = await continueCheckWatch(watch, {
      observe: observe(ctx.signal),
      wait: true,
      timeoutMs: bounds.timeoutMs,
      pollIntervalMs: bounds.pollIntervalMs,
      signal: ctx.signal,
      sleepFirst: false,
      ...(ctx.progress
        ? {
            onWaiting: (step: CheckObservation<Summary>) =>
              ctx.progress!(
                jsonResult({
                  provider: options.providerName.toLowerCase(),
                  repo: options.repo,
                  ref: options.ref,
                  status: "waiting",
                  polls: watch.polls,
                  elapsedSeconds:
                    Math.round((Date.now() - watch.startedAt) / 100) / 10,
                  headSha: step.headSha,
                  checks: {
                    state: step.checks.state,
                    finished: false,
                    total: step.checks.total ?? step.checks.checks.length,
                  },
                }),
              ),
          }
        : {}),
    });
    return compactResult(await report(outcome, ctx.signal, bounds.timeoutMs));
  }
  throwIfAborted(ctx.signal);
  const first = await pollCheckWatch(watch, {
    observe: observe(ctx.signal),
    wait: true,
    timeoutMs: bounds.timeoutMs,
  });
  if (first.outcome)
    return compactResult(
      await report(first.outcome, ctx.signal, bounds.timeoutMs),
    );
  const target = `${options.repo}@${options.ref}`;
  return jsonResult(
    await launchServerTask({
      ctx,
      kind: "check-watch",
      label: `${options.providerName} checks ${target}`,
      command: `${options.toolName} ${target}`,
      sourceTool: options.toolName,
      requestedTimeoutMs: bounds.timeoutMs,
      async run(budget) {
        const outcome = await continueCheckWatch(watch, {
          observe: observe(budget.signal),
          wait: true,
          timeoutMs: budget.timeoutMs,
          pollIntervalMs: bounds.pollIntervalMs,
          signal: budget.signal,
          sleepFirst: true,
        });
        const observation = options.observe(outcome.snapshot);
        return {
          payload: await report(outcome, budget.signal, budget.timeoutMs),
          summary: checkWaitSummary({
            ...outcome,
            checks: observation.checks,
            head: observation.headSha.slice(0, 7),
            providerName: options.providerName,
            timeoutMs: budget.timeoutMs,
          }),
        };
      },
    }),
  );
}
