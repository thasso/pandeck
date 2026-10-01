/**
 * Public surface of the pi SDK integration. All pi
 * (`@earendil-works/pi-coding-agent`) usage is being consolidated under
 * `piSdk/`; modules outside this folder should import pi-related helpers and
 * the pi package types they need from here rather than from the pi package
 * directly.
 */
export * from "./agentToolAdapter.ts";
export * from "./toolActivation.ts";
export * from "./models.ts";
export * from "./oneShot.ts";
export * from "./options.ts";
export * from "./piStore.ts";
export * from "./sessionOpen.ts";
export * from "./forkOrigin.ts";

/** Pi package types that non-piSdk modules still legitimately consume. */
export type {
  AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
