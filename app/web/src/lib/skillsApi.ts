/**
 * The read of ONE skill's `SKILL.md` ([Task-614](pa://task/614)).
 *
 * The library LIST arrives on the `skills` topic through `useAssistant`; only
 * the body is fetched, and only for the row the user opened. A skill is
 * addressed by its declared name, which is also how settings key its toggle, so
 * nothing here ever sends a path.
 */
import type {
  SkillDetailResponse,
  SkillFilePreviewResponse,
} from "@assistant/shared";
import { authHeaders, serverHttpOrigin, withToken } from "./serverOrigin.ts";

export async function fetchSkillDetail(
  name: string,
  signal?: AbortSignal,
): Promise<SkillDetailResponse> {
  const res = await fetch(
    `${serverHttpOrigin()}/api/skills/detail?name=${encodeURIComponent(name)}`,
    { headers: { ...authHeaders() }, ...(signal ? { signal } : {}) },
  );
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (json as { error?: unknown }).error;
    throw new Error(
      typeof error === "string" ? error : `Request failed (${res.status})`,
    );
  }
  return json as SkillDetailResponse;
}

/** Token-carrying raw/download URL for one skill-relative regular file. */
export function skillFileUrl(name: string, path: string): string {
  const query = `name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}`;
  return withToken(`${serverHttpOrigin()}/api/skills/file?${query}`);
}

/** Bounded JSON preview for a text or Markdown supporting file. */
export async function fetchSkillFilePreview(
  key: string,
  signal?: AbortSignal,
): Promise<SkillFilePreviewResponse> {
  const separator = key.indexOf("\0");
  if (separator <= 0) throw new Error("Invalid skill file preview key.");
  const name = key.slice(0, separator);
  const path = key.slice(separator + 1);
  const query = `name=${encodeURIComponent(name)}&path=${encodeURIComponent(path)}&preview=text`;
  const res = await fetch(`${serverHttpOrigin()}/api/skills/file?${query}`, {
    headers: { ...authHeaders() },
    ...(signal ? { signal } : {}),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (json as { error?: unknown }).error;
    throw new Error(
      typeof error === "string" ? error : `Request failed (${res.status})`,
    );
  }
  return json as SkillFilePreviewResponse;
}
