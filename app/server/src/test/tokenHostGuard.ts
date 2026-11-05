/**
 * Keeps every test off the real OAuth token hosts. The gateway's renewal
 * POSTs to `platform.claude.com` unless a test hands it a fake endpoint, and
 * pi's Codex refresh fetches `auth.openai.com` unless a test stubs `fetch`; a
 * test that forgets either must fail, never send a fake refresh token out.
 *
 * Installed once per test worker by `setup.ts`, it refuses those hosts at
 * the name lookup, before any resolver or socket is touched, which covers
 * `https.request` and Node's `fetch` alike, and refuses `fetch` URLs naming
 * them too, for a fetch routed through a proxy. Each refusal is recorded;
 * `setup.ts` fails the test that caused one.
 */
import dns from "node:dns";

const TOKEN_HOSTS = new Set(["platform.claude.com", "auth.openai.com"]);
/** The refusal's error code. */
export const TOKEN_HOST_REFUSED = "EPANDECKTOKENHOST";

const attempts: string[] = [];

function isTokenHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    TOKEN_HOSTS.has(host.toLowerCase().replace(/\.$/, ""))
  );
}

function refusal(host: string): NodeJS.ErrnoException {
  attempts.push(host);
  return Object.assign(
    new Error(`tests never reach the real token host ${host}`),
    { code: TOKEN_HOST_REFUSED, hostname: host },
  );
}

let installed = false;

export function installTokenHostGuard(): void {
  if (installed) return;
  installed = true;
  const lookup = dns.lookup;
  dns.lookup = function guardedLookup(
    this: unknown,
    host: string,
    ...rest: unknown[]
  ) {
    if (isTokenHost(host)) {
      const callback = rest.at(-1);
      if (typeof callback === "function")
        process.nextTick(callback, refusal(host));
      return {};
    }
    return Reflect.apply(lookup, this, [host, ...rest]);
  } as typeof dns.lookup;
  const promisesLookup = dns.promises.lookup;
  dns.promises.lookup = function guardedPromisesLookup(
    this: unknown,
    host: string,
    ...rest: unknown[]
  ) {
    if (isTokenHost(host)) return Promise.reject(refusal(host));
    return Reflect.apply(promisesLookup, this, [host, ...rest]);
  } as typeof dns.promises.lookup;
  const fetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    let host: string | undefined;
    try {
      host = new URL(input instanceof Request ? input.url : String(input))
        .hostname;
    } catch {
      // Not an absolute URL: fetch itself refuses it.
    }
    if (isTokenHost(host))
      return Promise.reject(
        new TypeError("fetch failed", { cause: refusal(host) }),
      );
    return fetch(input, init);
  };
}

/** The token hosts refused since the last call, oldest first; clears them. */
export function takeTokenHostAttempts(): string[] {
  return attempts.splice(0);
}
