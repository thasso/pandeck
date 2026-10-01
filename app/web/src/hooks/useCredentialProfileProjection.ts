import { useEffect, useRef, useState } from "react";
import type { LoadState } from "../lib/loadState.ts";
import {
  fetchCredentialProfilesWithModels,
  type CredentialProfileProjection,
} from "../lib/credentialProfiles.ts";
import { useFetchState, useReloadOnToken } from "./useFetchState.ts";

const PROJECTION_KEY = "credential-profile-projection";

export interface CredentialProfileProjectionFetch {
  state: LoadState<CredentialProfileProjection>;
  reload: () => void;
}

/**
 * Boot + invalidation policy for the new-session account/model projection.
 *
 * A healthy first boot performs one HTTP read. Reconnects and profile mutations
 * refresh the same key, while a first socket connection retries once if the
 * boot read already failed (or fails while that connection is establishing).
 */
export function useCredentialProfileProjection({
  connected,
  initialData,
  onProjection,
}: {
  connected: boolean;
  initialData?: CredentialProfileProjection;
  onProjection: (projection: CredentialProfileProjection) => void;
}): CredentialProfileProjectionFetch {
  const [reloadToken, setReloadToken] = useState(0);
  const result = useFetchState<CredentialProfileProjection>(
    PROJECTION_KEY,
    async (_key, signal) => {
      const projection = await fetchCredentialProfilesWithModels(
        reloadToken,
        signal,
      );
      onProjection(projection);
      return projection;
    },
    { ...(initialData !== undefined ? { initialData } : {}) },
  );
  useReloadOnToken(PROJECTION_KEY, reloadToken, result.reload);

  const connection = useRef({
    connected: false,
    hasConnected: false,
    recoveryAttempted: false,
  });
  useEffect(() => {
    const episode = connection.current;
    if (!connected) {
      episode.connected = false;
      episode.recoveryAttempted = false;
      return;
    }

    if (!episode.connected) {
      episode.connected = true;
      if (episode.hasConnected) {
        // Every reconnect is an invalidation of the same projection.
        episode.recoveryAttempted = true;
        setReloadToken((token) => token + 1);
      }
      episode.hasConnected = true;
    }

    if (result.state.status === "error" && !episode.recoveryAttempted) {
      // The boot HTTP read can fail before OR just after `ready`. Recover once
      // when this first live connection proves the server is reachable.
      episode.recoveryAttempted = true;
      setReloadToken((token) => token + 1);
    }
  }, [connected, result.state.status]);

  useEffect(() => {
    const invalidate = () => setReloadToken((token) => token + 1);
    window.addEventListener("credentialProfilesChanged", invalidate);
    return () =>
      window.removeEventListener("credentialProfilesChanged", invalidate);
  }, []);

  return result;
}
