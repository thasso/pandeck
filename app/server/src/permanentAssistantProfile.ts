import type { AppSettings } from "@assistant/shared";

/** Session-fixed identity and user instructions appended to the permanent Assistant persona. */
export function permanentAssistantProfileInstructions(
  profile: AppSettings["permanentAssistant"],
): string {
  const name = profile.name.trim() || "Larry";
  const additional = profile.additionalInstructions.trim();
  return [
    `Your name is ${JSON.stringify(name)}. Use this name when identifying yourself or when the user asks your name.`,
    additional,
  ]
    .filter(Boolean)
    .join("\n\n");
}
