/**
 * The topics that run on the state topic kernel, one kernel each, and their
 * wiring: committed change sets report into them, and the hub's topic
 * broadcaster publishes from them. Tasks, Projects and Initiatives still
 * publish from `hub.ts` until they move (`docs/state-sync.md`).
 */
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";
import { backgroundWorkTopic } from "./backgroundWorkRegistry.ts";
import { setStateChangeSink } from "./db/changeSet.ts";
import { createStateTopic, type StateTopic } from "./stateTopicKernel.ts";

const background = createStateTopic(backgroundWorkTopic);

const topics = new Map<
  BroadcastTopic,
  StateTopic<BroadcastTopic, unknown, ServerMessage>
>([["background", background]]);

/** The kernel answering `topic`, when that topic runs on one. */
export function stateTopicFor(
  topic: BroadcastTopic,
): StateTopic<BroadcastTopic, unknown, ServerMessage> | undefined {
  return topics.get(topic);
}

/**
 * Start publishing: every kernel sends through `broadcast`, and every
 * committed change set reports into its topic's kernel. Called once, by the
 * hub.
 */
export function attachStateTopics(
  broadcast: (topic: BroadcastTopic, message: ServerMessage) => void,
): void {
  background.attach(broadcast);
  setStateChangeSink((topic, ids) => topics.get(topic)?.report(ids));
}

/** Test seam: run every kernel's SCHEDULED flush now, and nothing more. */
export function flushStateTopicsForTests(): void {
  for (const kernel of topics.values()) kernel.flushNow();
}
