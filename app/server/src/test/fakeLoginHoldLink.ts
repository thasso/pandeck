/**
 * A fake of the link's login-hold calls (`loginHolds.ts`), for the login
 * flows' tests: every call lands in `events` in order, and a test decides
 * when and how an acquire or a writer registration answers. It reaches no
 * gateway.
 */
import type { GatewayLink, LoginStatus } from "../gatewayLink.ts";

/** A promise a test settles. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type HoldCalls = Pick<
  GatewayLink,
  | "acquireLoginHold"
  | "registerLoginWriter"
  | "releaseLoginHold"
  | "forceReleaseLoginHold"
  | "loginStatus"
  | "onLoginStatus"
>;

export interface FakeLoginHoldLink {
  link: HoldCalls;
  /** `acquire <profile>`, `writer <hold> <pid>`, `release <hold>`, `force <hold>`, in call order. */
  events: string[];
  /** What the next acquire answers; a hold id by default. */
  acquire: (profileId: string) => Promise<string>;
  /** What the next writer registration answers; done by default. */
  register: (holdId: string, pid: number) => Promise<void>;
  /** What a force release answers; done by default. */
  forceRelease: (holdId: string) => Promise<void>;
  /** Records `status` as the gateway's latest for the profile and tells the listeners. */
  status(profileId: string, status: LoginStatus): void;
}

export function fakeLoginHoldLink(events: string[] = []): FakeLoginHoldLink {
  const statuses = new Map<string, LoginStatus>();
  const listeners = new Set<(profileId: string, status: LoginStatus) => void>();
  let holds = 0;
  const fake: FakeLoginHoldLink = {
    events,
    acquire: () => Promise.resolve(`hold-${++holds}`),
    register: () => Promise.resolve(),
    forceRelease: () => Promise.resolve(),
    status(profileId, status) {
      statuses.set(profileId, status);
      for (const listener of [...listeners]) listener(profileId, status);
    },
    link: {
      acquireLoginHold(profileId) {
        events.push(`acquire ${profileId}`);
        return fake.acquire(profileId);
      },
      registerLoginWriter(holdId, pid) {
        events.push(`writer ${holdId} ${pid}`);
        return fake.register(holdId, pid);
      },
      releaseLoginHold(holdId) {
        events.push(`release ${holdId}`);
        return Promise.resolve();
      },
      forceReleaseLoginHold(holdId) {
        events.push(`force ${holdId}`);
        return fake.forceRelease(holdId);
      },
      loginStatus: (profileId) => statuses.get(profileId),
      onLoginStatus(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return fake;
}
