/**
 * The words a running session's progress line says, from what its runtime
 * OBSERVED (`RunProgress`) — never from transcript rows, which only change when
 * an assistant turn commits.
 *
 * The line states what the run is doing and how long it has been doing it.
 * Silence is reported as silence: a model that has produced nothing for two
 * minutes reads "Waiting for model 2m", never "stalled", and no duration on its
 * own changes the line's tone. Only a retry the provider itself reported does.
 */
import {
  runProgressAge,
  runProgressPhase,
  type RunProgress,
} from "@assistant/shared/session";
import { elapsedLabel } from "./relativeTime.ts";

/** A progress value with the local time it arrived, which is what ages it. */
export interface LiveRunProgress {
  progress: RunProgress;
  receivedAt: number;
}

export interface RunProgressQueues {
  /** Messages other sessions sent that wait for this one. */
  peers: number;
  /** Background-work updates waiting to reach it. */
  background: number;
}

export interface RunProgressView {
  /** The state, short: "Running command", "Waiting for model". */
  label: string;
  /** How long the run has been in that state, compact. */
  elapsed?: string;
  /** Further facts, each a short phrase, most relevant first. */
  details: string[];
  /** `warning` only while the provider reports it is retrying. */
  tone: "default" | "warning";
  /** Everything above as sentences, for a tooltip or screen reader. */
  description: string;
}

/** Model output this recent reads as continuous; older output gets its age. */
const QUIET_OUTPUT_MS = 10_000;

const TOOL_VERBS: Record<string, string> = {
  bash: "Running command",
  read: "Reading files",
  write: "Writing file",
  edit: "Editing file",
  multiedit: "Editing file",
  grep: "Searching",
  glob: "Searching",
  find: "Searching",
  ls: "Listing files",
};

/** A tool's name as a reader knows it: no `mcp__server__` prefix. */
export function toolDisplayName(name: string): string {
  const mcp = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(name);
  return mcp?.[1] ?? name;
}

/** What a running tool is doing, in the transcript's existing words. */
export function toolActivityLabel(name: string): string {
  const short = toolDisplayName(name);
  return TOOL_VERBS[short.toLowerCase()] ?? `Running ${short}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The waiting work this session has, as phrases; none when nothing waits. */
function queuedWorkPhrases(queues: RunProgressQueues): string[] {
  const phrases: string[] = [];
  if (queues.peers > 0)
    phrases.push(
      `${plural(queues.peers, "peer message", "peer messages")} waiting`,
    );
  if (queues.background > 0)
    phrases.push(
      `${plural(queues.background, "background update", "background updates")} waiting`,
    );
  return phrases;
}

/**
 * The line for a running run. `lastBlock` is the kind of the streaming
 * message's newest block, which tells thinking from answering once output is
 * arriving; the progress itself carries no content.
 */
export function runProgressView(
  live: LiveRunProgress,
  now: number,
  options: {
    lastBlock?: string | undefined;
    queues: RunProgressQueues;
  },
): RunProgressView {
  const { progress, receivedAt } = live;
  const ago = (at: number) =>
    elapsedLabel(runProgressAge(progress, at, receivedAt, now));
  const details: string[] = [];
  const sentences: string[] = [];
  let label: string;
  let elapsed: string | undefined;
  let tone: RunProgressView["tone"] = "default";

  switch (runProgressPhase(progress)) {
    case "tool": {
      // The oldest running tool is the one the run has waited on longest.
      const [oldest, ...others] = progress.runningTools;
      label = toolActivityLabel(oldest!.name);
      elapsed = ago(oldest!.startedAt);
      if (others.length > 0)
        details.push(
          `${plural(progress.runningTools.length, "tool", "tools")} running`,
        );
      sentences.push(
        `${toolDisplayName(oldest!.name)} has been running for ${elapsed}.`,
      );
      if (others.length > 0)
        sentences.push(
          `Also running: ${others.map((tool) => toolDisplayName(tool.name)).join(", ")}.`,
        );
      break;
    }
    case "retrying": {
      const retry = progress.retry!;
      tone = "warning";
      label = "Retrying request";
      elapsed = ago(progress.awaitingModelSince ?? retry.at);
      const attempt =
        retry.maxAttempts !== undefined
          ? `attempt ${retry.attempt} of ${retry.maxAttempts}`
          : `attempt ${retry.attempt}`;
      details.push(attempt);
      if (retry.status !== undefined) details.push(`HTTP ${retry.status}`);
      sentences.push(
        `The provider reported a failed request and is retrying (${attempt}${retry.status !== undefined ? `, HTTP ${retry.status}` : ""}). Waiting for the model for ${elapsed}.`,
      );
      break;
    }
    case "waiting": {
      label = "Waiting for model";
      elapsed = ago(progress.awaitingModelSince!);
      sentences.push(`No model output for ${elapsed} since input was sent.`);
      // The provider answered — a response started, metadata arrived — but
      // produced nothing yet. Alive is all that says; it is not output.
      if (progress.lastActivityAt > progress.awaitingModelSince!) {
        const alive = ago(progress.lastActivityAt);
        details.push(`provider active ${alive} ago`);
        sentences.push(
          `The provider was last active ${alive} ago, with no output.`,
        );
      }
      break;
    }
    case "receiving": {
      label =
        options.lastBlock === "thinking"
          ? "Thinking"
          : options.lastBlock === "text"
            ? "Responding"
            : "Generating";
      const outputAt = progress.lastModelOutputAt ?? progress.lastActivityAt;
      const quietMs = runProgressAge(progress, outputAt, receivedAt, now);
      if (quietMs >= QUIET_OUTPUT_MS) {
        details.push(`last output ${elapsedLabel(quietMs)} ago`);
        sentences.push(`Last model output ${elapsedLabel(quietMs)} ago.`);
      } else sentences.push("Model output is arriving.");
      break;
    }
  }

  const lastTool = progress.lastTool;
  if (lastTool && lastTool.state !== "started") {
    const verb = lastTool.state === "failed" ? "failed" : "finished";
    const phrase = `${toolDisplayName(lastTool.name)} ${verb} ${ago(lastTool.at)} ago`;
    // Beside a wait it says what the model is answering; elsewhere it is
    // only in the description, so the line stays short.
    if (runProgressPhase(progress) === "waiting") details.push(phrase);
    sentences.push(`${phrase}.`);
  }
  const queued = queuedWorkPhrases(options.queues);
  details.push(...queued);
  if (queued.length > 0) sentences.push(`${queued.join(", ")}.`);
  sentences.push(`Run started ${ago(progress.startedAt)} ago.`);

  return {
    label,
    ...(elapsed !== undefined ? { elapsed } : {}),
    details,
    tone,
    description: `${label}. ${sentences.join(" ")}`,
  };
}
