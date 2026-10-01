/**
 * The process-global session runtime backed by the app-owned file log at
 * `DATA_DIR/sessions/<id>/log.jsonl`.
 */
import { SessionLogStore } from "./log/index.ts";
import { SessionRuntime } from "./runtime/index.ts";

export const sessionRuntime = new SessionRuntime(new SessionLogStore());
