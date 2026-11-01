/**
 * The server's side of `skills.materialize` (`docs/workers.md`): a Worker's
 * engine asks for its frozen skill set before every loader reload, and the
 * server materializes it from the library into the content-addressed runtime
 * the loader reads. The request names no session and writes only that
 * runtime, so any admitted Worker may ask.
 */
import {
  WorkerMethodError,
  type MethodHandlers,
} from "../workerProtocol/connection.ts";
import {
  SKILL_METHODS,
  SKILLS_UNAVAILABLE,
  decodeSkillMaterialize,
} from "../workerProtocol/skillMethods.ts";
import type { AdmittedPeer } from "./appToolHost.ts";

let served = 0;

/** The server's `skills.*` handlers for one Worker connection. */
export function skillHandlers(
  peer: () => AdmittedPeer | undefined,
): MethodHandlers {
  return {
    [SKILL_METHODS.materialize]: async (payload) => {
      const { names } = decodeSkillMaterialize(payload);
      if (!peer())
        throw new WorkerMethodError(
          "not_placed",
          "This connection has no admitted Worker.",
        );
      served += 1;
      try {
        // Lazy: the skill library reaches the in-process Worker, which imports
        // this host, so a static import would close a cycle.
        const { scanSkillLibrary, skillLibraryStore } =
          await import("../skills/skillLibrary.ts");
        const { materializeSkillRuntime } =
          await import("../skills/skillRuntimeMaterializer.ts");
        await skillLibraryStore.ensureInitialized();
        const scan = await scanSkillLibrary(skillLibraryStore.root);
        await materializeSkillRuntime(names, scan);
      } catch (error) {
        throw new WorkerMethodError(
          SKILLS_UNAVAILABLE,
          error instanceof Error ? error.message : String(error),
        );
      }
      return { json: {} };
    },
  };
}

/** Test seam: how many materializations the server has admitted and served. */
export function skillMaterializationsServedForTests(): number {
  return served;
}
