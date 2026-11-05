/**
 * The server's own pi model runtimes as an engine reaches them
 * ({@link PiModelPort}): each credential profile keeps its one cached runtime
 * and refresher (`models.ts`), and no credential leaves the server process.
 * The phase-3 credential gateway replaces this wiring (`docs/workers.md`).
 */
import {
  availableModelsForProfile,
  findModelForProfile,
  modelRuntimeForProfile,
} from "./models.ts";
import type { PiModelPort } from "./piEngineHost.ts";

export const serverPiModelPort: PiModelPort = {
  runtime: (profileId) => modelRuntimeForProfile(profileId),
  findForProfile: (profileId, provider, id) =>
    findModelForProfile(profileId, provider, id),
  availableForProfile: (profileId) => availableModelsForProfile(profileId),
};
