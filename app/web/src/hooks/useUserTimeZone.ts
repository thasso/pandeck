import { createContext, useContext } from "react";

/**
 * The user's effective timezone, relayed from `useAssistant`'s
 * `settings.profile.effectiveTimeZone` by `App` — the zone the server resolves
 * user-local days in, so client and server agree on what "today" is. The
 * browser's zone is only the fallback for a tree rendered without a provider.
 */
export const UserTimeZoneContext = createContext<string>(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
);

export function useUserTimeZone(): string {
  return useContext(UserTimeZoneContext);
}
