/**
 * Public surface of the normalized session model, shared by server and web.
 * Imported as `@assistant/shared/session` by the runtime, transport, and client
 * reducers.
 */
export type {
  AgentContentBlock,
  AgentUsage,
  AgentStopReason,
  LazyBlockKind,
  LazyBlockRef,
  LiveBodyKey,
  LiveBodyRef,
} from "./content.ts";
export { bodyContentHash, liveBodyKeyId } from "./content.ts";
export type {
  BackgroundWorkPromptPresentation,
  PromptOrigin,
} from "./origin.ts";
export type {
  PromptDelivery,
  SessionEntry,
  SessionEntryEnvelope,
  SessionEntryOrigin,
} from "./entries.ts";
export type {
  SessionSnapshot,
  SnapshotRunState,
  StreamingEntry,
  StreamingMessageEntry,
  StreamingToolEntry,
} from "./snapshot.ts";
export type { SessionConfig, SessionConfigModel } from "./config.ts";
