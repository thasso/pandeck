/**
 * The OpenAI-compatible endpoints the server pushed (`compat.set`), one per
 * compatible profile, held in this process's memory only: never in
 * `stateDir`, a log or a refusal. A new server boot's hello clears them all,
 * and the removal of a profile clears its own; until that profile's next push
 * `/compat` answers 503 for its leases (`docs/workers.md` "Credentials").
 *
 * Each push replaces one immutable target, its origin and key together, so a
 * request that took a target keeps that pairing whatever is pushed meanwhile.
 * A target is reached only through its own profile id, which `/compat` takes
 * from the lease alone: a lease for one account never reaches another's key.
 */
import net from "node:net";
import { openAiCompatibleBaseUrl } from "../../../shared/openAiCompatibleValidation.ts";

/** Where `/compat` forwards, and with which key: one push, frozen. */
export interface CompatTarget {
  readonly protocol: "http" | "https";
  /** The address to connect to: an IPv6 literal without its brackets. */
  readonly hostname: string;
  readonly port: number;
  /** `URL.host`, the `Host` header. */
  readonly host: string;
  /** The TLS name; absent for an IP literal. */
  readonly servername: string | undefined;
  /** The base URL's path without trailing slashes, possibly empty. */
  readonly basePath: string;
  readonly apiKey: string;
}

function targetOf(url: URL, apiKey: string): CompatTarget {
  const protocol = url.protocol === "https:" ? "https" : "http";
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return Object.freeze({
    protocol,
    hostname,
    port: url.port ? Number(url.port) : protocol === "https" ? 443 : 80,
    host: url.host,
    servername: net.isIP(hostname) ? undefined : hostname,
    basePath: url.pathname.replace(/\/+$/, ""),
    apiKey,
  });
}

export interface CompatUpstream {
  /**
   * Holds the profile's pair; false, and holds nothing for that profile, for
   * a base URL it refuses.
   */
  set(profileId: string, baseUrl: string, apiKey: string): boolean;
  clear(profileId: string): void;
  clearAll(): void;
  /** Drops every pair whose profile `kept` does not hold. */
  retain(kept: (profileId: string) => boolean): void;
  /** The profile's target now; a request keeps the one it took. */
  current(profileId: string): CompatTarget | undefined;
}

/** Nothing here throws or saves: a pair lives and dies in memory. */
export function createCompatUpstream(): CompatUpstream {
  const targets = new Map<string, CompatTarget>();
  return {
    set(profileId, baseUrl, apiKey) {
      const url = openAiCompatibleBaseUrl(baseUrl);
      if (!url) {
        targets.delete(profileId);
        return false;
      }
      targets.set(profileId, targetOf(url, apiKey));
      return true;
    },
    clear(profileId) {
      targets.delete(profileId);
    },
    clearAll() {
      targets.clear();
    },
    retain(kept) {
      for (const profileId of [...targets.keys()])
        if (!kept(profileId)) targets.delete(profileId);
    },
    current: (profileId) => targets.get(profileId),
  };
}
