import type { ProjectRecord } from "@assistant/shared";

/** Deterministic fallback color derived from project id; Project records may override it with `color`. */
export function projectColor(
  project: string | Pick<ProjectRecord, "id" | "color">,
): { stripe: string; dot: string; soft: string } {
  const id = typeof project === "string" ? project : project.id;
  const explicit =
    typeof project === "string" ? undefined : project.color?.trim();
  if (explicit) {
    return {
      stripe: explicit,
      dot: explicit,
      soft: colorSoft(explicit),
    };
  }
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    stripe: `hsl(${hue}, 55%, 45%)`,
    dot: `hsl(${hue}, 60%, 50%)`,
    soft: `hsl(${hue}, 55%, 45% / 0.12)`,
  };
}

function colorSoft(color: string): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgb(${r} ${g} ${b} / 0.14)`;
  }
  return `color-mix(in srgb, ${color} 14%, transparent)`;
}

export function buildProjectsById(
  projects: ProjectRecord[],
): Map<string, ProjectRecord> {
  const map = new Map<string, ProjectRecord>();
  for (const p of projects) map.set(p.id, p);
  return map;
}

export function resolveProjectDisplay(
  projectId: string,
  projectsById: Map<string, ProjectRecord>,
): { id: string; label: string; shortLabel: string; known: boolean } {
  const record = projectsById.get(projectId);
  if (record) {
    const shortLabel = projectDisplayKey(record);
    return { id: projectId, label: record.name, shortLabel, known: true };
  }
  // Fallback: make the raw id readable (replace hyphens/underscores with spaces, keep it short)
  const label = projectId.replace(/[-_]/g, " ").slice(0, 40);
  return { id: projectId, label, shortLabel: label, known: false };
}

export function projectDisplayKey(project: ProjectRecord): string {
  return project.key.trim().toUpperCase();
}
