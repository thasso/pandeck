/**
 * Which build of the browser app this is.
 *
 * Baked in by `vite.config.ts` as the `__ASSISTANT_BUILD__` define, because a
 * loaded bundle has nothing left to ask: the version and commit are properties
 * of the build, not of the running page. The server's own build arrives
 * separately on `ready` and the shell reports its own through `shell_info` —
 * three answers, shown side by side in Settings → About.
 */
import type { BuildInfo } from "@assistant/shared/buildInfo";

/**
 * The define is missing only where something other than Vite loaded this module,
 * so the fallback names that rather than pretending to a version.
 */
const UNKNOWN: BuildInfo = { version: "unknown" };

export function appBuildInfo(): BuildInfo {
  return typeof __ASSISTANT_BUILD__ === "undefined"
    ? UNKNOWN
    : __ASSISTANT_BUILD__;
}
