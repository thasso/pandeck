/**
 * Which tools a session exposes to its model, as the session view shows them
 * (`docs/agent-harnesses.md`). pi records the exposure of the tool runtime it
 * built for a session; a session it never built one for has none to show.
 */
export { toolExposureForSession } from "../piSdk/toolActivation.ts";
