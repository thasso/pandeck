/**
 * The ONE outward event vocabulary the runtime emits to the transport. The
 * transport maps these onto wire messages; the runtime never emits wire messages
 * directly.
 *
 * Live stream events are keyed by `streamId` (transient); durable rows arrive as
 * `entryAppended` keyed by the entry's `id`/`seq`. A completed stream's
 * `*Completed` event is emitted BEFORE its durable `entryAppended` replacement;
 * clients should keep completed assistant streams visible until that replacement
 * entry is applied so the handoff is gap-free without duplicate durable rows.
 */
// The RuntimeEvent vocabulary lives in the shared package so the client reducer
// can consume it on the wire; re-exported here for server imports.
export type {
  RuntimeEvent,
  RuntimeEventListener,
} from "@assistant/shared/runtime";
