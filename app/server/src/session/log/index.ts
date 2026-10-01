/**
 * The app-owned, append-only session log. Passive storage: the runtime appends
 * finalized entries here and reads the projected views; this module imports
 * nothing from adapters/runtime/transport.
 */
export { SessionLogStore } from "./store.ts";
