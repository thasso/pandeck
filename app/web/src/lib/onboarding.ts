import type { OnboardingState } from "@assistant/shared";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/**
 * End first-run guided setup (`docs/onboarding.md`). The server broadcasts the
 * new state to every client; the answer only says the request was taken.
 */
export async function finishOnboarding(): Promise<OnboardingState> {
  const res = await fetch(`${serverHttpOrigin()}/api/onboarding/finish`, {
    method: "POST",
    headers: authHeaders(),
  });
  const value = (await res.json().catch(() => null)) as {
    state?: OnboardingState;
    error?: string;
  } | null;
  if (!res.ok || !value?.state)
    throw new Error(value?.error ?? `Setup could not finish (${res.status}).`);
  return value.state;
}
