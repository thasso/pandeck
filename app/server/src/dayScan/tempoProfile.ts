import { KnowledgeBaseStore } from "../knowledgeBaseStore.ts";
import { DAY_SCAN_ACTOR_NAME } from "./types.ts";
import {
  TEMPO_PROFILE_ENTRY_ID,
  TEMPO_PROFILE_ENTRY_PATH,
} from "./tempoPlan.ts";

/**
 * The learned Tempo-logging profile (plan § Tempo learning): a durable KB
 * reference entry that maps recurring meetings/activities to a Jira issue key +
 * default `activityKey`, plus start-time/rounding conventions. It is the ONLY
 * thing that lets deterministic derivation assign an issue key to a meeting, so
 * an empty profile proposes nothing (safe) and learns from confirmed
 * submissions. The JSON asset is the source of truth; the entry body is a
 * generated projection.
 */

export interface TempoProfileMapping {
  /** Case-insensitive substring matched against the meeting title. */
  titleMatch: string;
  issueKey: string;
  activityKey?: string;
}

/**
 * A responsibility-area route: an `area` (as tagged on contacts, e.g.
 * "resources") → the Jira ticket + activity time for that area books to. The
 * cached `profitCenter` is a confirmation hint only (Jira sets it via
 * automation; we never write it).
 */
export interface TempoAreaRoute {
  area: string;
  issueKey: string;
  activityKey?: string;
  profitCenter?: string;
}

/** A Team Workflow category → its ticket + activity (fallback bucket). */
interface TempoCategoryRoute {
  category: string;
  issueKey: string;
  activityKey?: string;
  profitCenter?: string;
}

export interface TempoProfile {
  version: number;
  /** Round derived durations to this many minutes (0 = no rounding). */
  roundToMinutes: number;
  defaultActivityKey: string | null;
  mappings: TempoProfileMapping[];
  /** Responsibility-area → ticket routes (participant/topic routing). */
  areas: TempoAreaRoute[];
  /** Team Workflow category → ticket routes (fallback bucket). */
  categories: TempoCategoryRoute[];
  /** Per-issue default activity key (learned/curated), issueKey → activityKey. */
  ticketDefaults: Record<string, string>;
  /** Last-resort general time-tracking ticket. */
  generalIssueKey: string | null;
}

const TEMPO_PROFILE_ASSET_PATH = `${TEMPO_PROFILE_ENTRY_PATH}/assets/profile.json`;

export function emptyTempoProfile(): TempoProfile {
  return {
    version: 1,
    roundToMinutes: 0,
    defaultActivityKey: null,
    mappings: [],
    areas: [],
    categories: [],
    ticketDefaults: {},
    generalIssueKey: null,
  };
}

function parseAreaRoutes(raw: unknown): TempoAreaRoute[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is TempoAreaRoute =>
      Boolean(
        r && typeof r.area === "string" && typeof r.issueKey === "string",
      ),
    )
    .map((r) => {
      const activityKeyValue = r.activityKey?.toUpperCase();
      return {
        area: r.area.trim().toLowerCase(),
        issueKey: r.issueKey.toUpperCase(),
        ...(activityKeyValue !== undefined
          ? { activityKey: activityKeyValue }
          : {}),
        ...(r.profitCenter !== undefined
          ? { profitCenter: r.profitCenter }
          : {}),
      };
    });
}

function parseCategoryRoutes(raw: unknown): TempoCategoryRoute[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is TempoCategoryRoute =>
      Boolean(
        r && typeof r.category === "string" && typeof r.issueKey === "string",
      ),
    )
    .map((r) => {
      const activityKeyValue = r.activityKey?.toUpperCase();
      return {
        category: r.category.trim(),
        issueKey: r.issueKey.toUpperCase(),
        ...(activityKeyValue !== undefined
          ? { activityKey: activityKeyValue }
          : {}),
        ...(r.profitCenter !== undefined
          ? { profitCenter: r.profitCenter }
          : {}),
      };
    });
}

function parseTicketDefaults(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim())
      out[key.toUpperCase()] = value.toUpperCase();
  }
  return out;
}

function parseTempoProfile(raw: string | null): TempoProfile {
  if (!raw) return emptyTempoProfile();
  try {
    const parsed = JSON.parse(raw) as Partial<TempoProfile>;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      roundToMinutes:
        typeof parsed.roundToMinutes === "number" && parsed.roundToMinutes > 0
          ? parsed.roundToMinutes
          : 0,
      defaultActivityKey:
        typeof parsed.defaultActivityKey === "string"
          ? parsed.defaultActivityKey
          : null,
      mappings: Array.isArray(parsed.mappings)
        ? parsed.mappings
            .filter((m): m is TempoProfileMapping =>
              Boolean(
                m &&
                typeof m.titleMatch === "string" &&
                typeof m.issueKey === "string",
              ),
            )
            .map((m) => {
              const activityKey = m.activityKey?.toUpperCase();
              return {
                titleMatch: m.titleMatch,
                issueKey: m.issueKey.toUpperCase(),
                ...(activityKey !== undefined ? { activityKey } : {}),
              };
            })
        : [],
      areas: parseAreaRoutes(parsed.areas),
      categories: parseCategoryRoutes(parsed.categories),
      ticketDefaults: parseTicketDefaults(parsed.ticketDefaults),
      generalIssueKey:
        typeof parsed.generalIssueKey === "string" &&
        parsed.generalIssueKey.trim()
          ? parsed.generalIssueKey.toUpperCase()
          : null,
    };
  } catch {
    return emptyTempoProfile();
  }
}

/** Default activity for an issue: the per-ticket default, else the global default. */
export function activityForIssue(
  profile: TempoProfile,
  issueKey: string,
): string | null {
  return (
    profile.ticketDefaults[issueKey.toUpperCase()] ?? profile.defaultActivityKey
  );
}

/** Route by responsibility area (first case-insensitive match). Null = unrouted. */
export function matchAreaRoute(
  profile: TempoProfile,
  area: string,
): TempoAreaRoute | null {
  const lower = area.trim().toLowerCase();
  return profile.areas.find((r) => r.area === lower) ?? null;
}

export async function readTempoProfile(
  store: KnowledgeBaseStore,
): Promise<TempoProfile> {
  try {
    return parseTempoProfile(
      await store.readEntryFile(TEMPO_PROFILE_ASSET_PATH),
    );
  } catch {
    return emptyTempoProfile();
  }
}

export interface ProfileMatch {
  issueKey: string;
  activityKey: string | null;
}

/** Match a meeting title to a mapping (first case-insensitive substring hit). Null = unmapped. */
export function matchTempoProfile(
  profile: TempoProfile,
  title: string,
): ProfileMatch | null {
  const lower = title.toLowerCase();
  for (const mapping of profile.mappings) {
    if (
      mapping.titleMatch &&
      lower.includes(mapping.titleMatch.toLowerCase())
    ) {
      return {
        issueKey: mapping.issueKey,
        activityKey: mapping.activityKey ?? profile.defaultActivityKey,
      };
    }
  }
  return null;
}

/** Round seconds to the profile's minute grid (idempotent; 0 = passthrough). */
export function roundDuration(profile: TempoProfile, seconds: number): number {
  if (profile.roundToMinutes <= 0) return seconds;
  const grid = profile.roundToMinutes * 60;
  return Math.max(grid, Math.round(seconds / grid) * grid);
}

/**
 * Learn from a confirmed submission: upsert a title→issueKey mapping (pure).
 * A correction (same titleMatch, different issueKey/activityKey) replaces it.
 */
export function upsertProfileMapping(
  profile: TempoProfile,
  mapping: TempoProfileMapping,
): TempoProfile {
  const titleMatch = mapping.titleMatch.trim();
  if (!titleMatch) return profile;
  const next = profile.mappings.filter(
    (m) => m.titleMatch.toLowerCase() !== titleMatch.toLowerCase(),
  );
  const activityKeyValue = mapping.activityKey?.toUpperCase();
  next.push({
    titleMatch,
    issueKey: mapping.issueKey.toUpperCase(),
    ...(activityKeyValue !== undefined
      ? { activityKey: activityKeyValue }
      : {}),
  });
  return { ...profile, mappings: next };
}

function renderProfileEntry(profile: TempoProfile): string {
  const now = new Date().toISOString();
  const lines = [
    "---",
    "kb:",
    "  schema: 1",
    `  id: ${TEMPO_PROFILE_ENTRY_ID}`,
    "  type: reference",
    '  title: "Tempo logging profile"',
    "  status: active",
    `  createdAt: "${now}"`,
    `  updatedAt: "${now}"`,
    "  tags:",
    "    - day-scan",
    "    - tempo",
    "---",
    "# Tempo logging profile",
    "",
    "<!-- Learned meeting → Jira issue mappings for Tempo derivation. The JSON asset is the source of truth. -->",
    "",
    `Default activity: ${profile.defaultActivityKey ?? "—"} · rounding: ${profile.roundToMinutes || "none"} min`,
    "",
  ];
  lines.push("## Meeting title → issue");
  if (profile.mappings.length === 0)
    lines.push("No learned title mappings yet.");
  else
    for (const m of profile.mappings)
      lines.push(
        `- \`${m.titleMatch}\` → **${m.issueKey}**${m.activityKey ? ` (${m.activityKey})` : ""}`,
      );

  lines.push("", "## Area → ticket");
  if (profile.areas.length === 0) lines.push("No area routes yet.");
  else
    for (const r of profile.areas)
      lines.push(
        `- \`${r.area}\` → **${r.issueKey}**${r.activityKey ? ` (${r.activityKey})` : ""}${r.profitCenter ? ` · ${r.profitCenter}` : ""}`,
      );

  lines.push("", "## Team Workflow categories");
  if (profile.categories.length === 0) lines.push("No category routes yet.");
  else
    for (const r of profile.categories)
      lines.push(
        `- ${r.category} → **${r.issueKey}**${r.activityKey ? ` (${r.activityKey})` : ""}${r.profitCenter ? ` · ${r.profitCenter}` : ""}`,
      );

  const ticketDefaults = Object.entries(profile.ticketDefaults);
  if (ticketDefaults.length > 0) {
    lines.push("", "## Per-ticket default activity");
    for (const [issueKey, activityKey] of ticketDefaults)
      lines.push(`- **${issueKey}** → ${activityKey}`);
  }

  lines.push(
    "",
    `General time-tracking ticket: ${profile.generalIssueKey ? `**${profile.generalIssueKey}**` : "—"}`,
  );
  return `${lines.join("\n").trim()}\n`;
}

/** Persist a profile change as a day-scan-owned commit (asset + generated projection). */
export async function writeTempoProfile(
  store: KnowledgeBaseStore,
  profile: TempoProfile,
): Promise<void> {
  await store.commitChanges(
    [
      {
        op: "write",
        path: TEMPO_PROFILE_ASSET_PATH,
        content: JSON.stringify(profile, null, 2),
      },
      {
        op: "write",
        path: `${TEMPO_PROFILE_ENTRY_PATH}/index.md`,
        content: renderProfileEntry(profile),
      },
    ],
    {
      actor: { kind: "system", name: DAY_SCAN_ACTOR_NAME },
      reason: "day-scan tempo profile update",
      entryIds: [TEMPO_PROFILE_ENTRY_ID],
    },
  );
}
