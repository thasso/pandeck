import type {
  KbActor,
  KbFileChange,
  KnowledgeBaseStore,
} from "../knowledgeBaseStore.ts";
import { DAY_SCAN_ACTOR_NAME, DAY_SYNTHESIS_ACTOR_NAME } from "./types.ts";
import { DATA_REGION_END, DATA_REGION_START } from "./appendix.ts";
import { MINUTES_REGION_END, MINUTES_REGION_START } from "./minutes.ts";

/**
 * Day-chat honest contract (plan Decision #10): the day session keeps the
 * ordinary assistant toolset, so this SERVER-SIDE guard — not a read-only
 * toolset — is what actually protects day-scan-owned artifacts from ordinary
 * agent/user KB commits. Only the `day-scan`/`day-synthesis` system actors may
 * write day assets or a day/meeting entry's GENERATED region; revision intents
 * ("revise the summary", "drop this Tempo row") must route through the
 * runner/apply channel, which commits as those actors.
 */
class DayScanGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayScanGuardError";
  }
}

/** The day-scan/day-synthesis system actors bypass the guard (they own these artifacts). */
function isDayScanActor(actor: KbActor): boolean {
  return (
    actor.kind === "system" &&
    (actor.name === DAY_SCAN_ACTOR_NAME ||
      actor.name === DAY_SYNTHESIS_ACTOR_NAME)
  );
}

/** Day-scan-owned ASSET paths: pure machine artifacts a user/agent never edits. */
function isGuardedAsset(path: string): boolean {
  return (
    /^daily-summaries\/[^/]+\/assets\//.test(path) ||
    /^meetings\/[^/]+\/assets\//.test(path)
  );
}

/** Day/meeting entry documents whose GENERATED region is guarded (Notes/narrative outside it are not). */
function isGuardedEntry(path: string): boolean {
  return (
    /^daily-summaries\/[^/]+\/index\.md$/.test(path) ||
    /^meetings\/[^/]+\/index\.md$/.test(path)
  );
}

/**
 * Concatenated generated-region content (day data region + minutes region),
 * whitespace-normalized so the deterministic Markdown formatter's reflow is not
 * mistaken for tampering — only real content changes inside markers differ.
 */
function generatedRegions(content: string): string {
  const regions: string[] = [];
  for (const [start, end] of [
    [DATA_REGION_START, DATA_REGION_END],
    [MINUTES_REGION_START, MINUTES_REGION_END],
  ] as const) {
    const s = content.indexOf(start);
    const e = content.indexOf(end);
    if (s !== -1 && e !== -1 && e > s)
      regions.push(content.slice(s, e + end.length));
  }
  return regions.join("\n").replace(/\s+/g, " ").trim();
}

async function readCommitted(
  store: KnowledgeBaseStore,
  path: string,
): Promise<string | null> {
  try {
    return await store.readEntryFile(path);
  } catch {
    return null;
  }
}

/**
 * Reject ordinary (non-day-scan) commits that would touch day-scan-owned
 * artifacts: any write/delete of a guarded asset, or a day/meeting entry write
 * that alters (or removes) the generated region. Editing `## Notes` or ordinary
 * narrative outside the markers stays allowed — the honest day-chat contract.
 * Must run inside the commit's validation hook, BEFORE any write.
 */
export async function assertDayScanArtifactsProtected(
  store: KnowledgeBaseStore,
  changes: KbFileChange[],
  actor: KbActor,
): Promise<void> {
  if (isDayScanActor(actor)) return;
  for (const change of changes) {
    const path = change.path;
    if (isGuardedAsset(path)) {
      throw new DayScanGuardError(
        `"${path}" is a day-scan-owned artifact and can only be changed through the day-scan/synthesis runner.`,
      );
    }
    if (!isGuardedEntry(path)) continue;
    const committed = await readCommitted(store, path);
    if (committed === null) continue; // brand-new entry: only the runner creates these; nothing to protect yet.
    const committedRegion = generatedRegions(committed);
    if (committedRegion === "") continue; // no generated region to protect.
    const nextRegion =
      change.op === "delete"
        ? ""
        : generatedRegions(
            typeof change.content === "string" ? change.content : "",
          );
    if (nextRegion !== committedRegion) {
      throw new DayScanGuardError(
        `"${path}" has a day-scan generated region that only the synthesis runner may rewrite; edit your notes outside the markers instead.`,
      );
    }
  }
}
