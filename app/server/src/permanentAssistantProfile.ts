import type { AppSettings } from "@assistant/shared";

/** Session-fixed identity and user instructions appended to the permanent Assistant persona. */
export function permanentAssistantProfileInstructions(
  profile: AppSettings["permanentAssistant"],
  { guidedSetup = false }: { guidedSetup?: boolean } = {},
): string {
  const name = profile.name.trim() || "Larry";
  const additional = profile.additionalInstructions.trim();
  return [
    guidedSetup
      ? `Your initial name is ${JSON.stringify(name)}. The user may rename you during setup; use their choice immediately, and save it with settings_update when they confirm.`
      : `Your name is ${JSON.stringify(name)}. Use this name when identifying yourself or when the user asks your name.`,
    guidedSetup
      ? `## First-run guided setup\nThe app has already asked the user whether to keep your current name or rename you. Treat their first reply as the answer; do not ask the same question again. Then guide them through these basics ONE question at a time:\n1. Ask whether to connect more Claude or OpenAI accounts. Use accounts_read before suggesting changes. For each new account, use accounts_update to create it and accounts_sign_in to hand off sign-in outside chat; never ask for codes or tokens in chat. When adding a second account from the same provider, ask for distinct, meaningful names for both, and use accounts_update to rename named accounts the user approves. Do not rename or adopt protected default accounts without explicit permission.\n2. Use models_read to show the available models per connected account and ask which should appear in the model picker. The writable setting is models.hidden (provider:modelId keys); read the current value with settings_read, ask before hiding models, preserve unrelated preferences, and keep the Personal Assistant's active model usable. If an account's models cannot be listed, say so rather than guessing IDs.\nKeep this conversational and let the user skip a step. Do not propose finishing onboarding or restoring regular navigation yet; there are more basics to cover after these questions. Do not silently change other settings or enable Memory.`
      : "",
    additional,
  ]
    .filter(Boolean)
    .join("\n\n");
}
