import type { OnboardingState } from "@assistant/shared/onboarding";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

export async function fetchOnboardingState(): Promise<OnboardingState> {
  const response = await fetch(`${serverHttpOrigin()}/api/onboarding`, {
    headers: authHeaders(),
  });
  if (!response.ok)
    throw new Error(`Couldn't check setup (${response.status}).`);
  return (await response.json()) as OnboardingState;
}

export async function beginOnboarding(): Promise<void> {
  const response = await fetch(`${serverHttpOrigin()}/api/onboarding/start`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Couldn't start setup (${response.status}).`,
    );
  }
}

export async function finishOnboarding(profileId: string): Promise<void> {
  const response = await fetch(`${serverHttpOrigin()}/api/onboarding`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Couldn't finish setup (${response.status}).`,
    );
  }
}
