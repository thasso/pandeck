/**
 * The Slack read core's metadata cache (Task-1454): per caller, bounded in
 * callers and in users, process memory only. A caller is a `cacheKey` — the
 * local tools use team and token tail, the gateway edge `teamId:userId` — so
 * one caller's lists never answer another's call. Import-free.
 *
 * Rules: a value answers only within `ttlMs` of its `fetchedAt`; touching a
 * key makes it most recent and creating one past `maxKeys` drops the least
 * recently touched; every access first drops bundles whose newest value is
 * `ttlMs` old; a key keeps at most `maxUsersPerKey` users, oldest-inserted
 * dropped first. Users are stored reduced to the fields the core reads.
 */

/** A Slack user reduced to what the read core reads. */
export interface SlackCachedUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  tz?: string;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

interface Stamped<T> {
  fetchedAt: number;
  value: T;
}

interface Bundle<C, G> {
  newestAt: number;
  users?: Stamped<SlackCachedUser[]>;
  userInfo: Map<string, Stamped<SlackCachedUser>>;
  conversations?: Stamped<C[]>;
  groups?: Stamped<G[]>;
}

export interface SlackMetadataCacheOptions {
  maxKeys: number;
  maxUsersPerKey: number;
  ttlMs: number;
  now(): number;
}

export interface SlackMetadataCache<C, G> {
  /** The `users.list` answer, if fresh. */
  users(key: string): SlackCachedUser[] | undefined;
  /** Stores a `users.list` answer and seeds each listed user; returns what was stored. */
  setUsers(key: string, users: readonly SlackCachedUser[]): SlackCachedUser[];
  user(key: string, userId: string): SlackCachedUser | undefined;
  /** Stores a `users.info` answer under `userId`; returns what was stored. */
  setUser(key: string, userId: string, user: SlackCachedUser): SlackCachedUser;
  /** The conversation list, if younger than both `maxAgeMs` and the TTL. */
  conversations(key: string, maxAgeMs: number): C[] | undefined;
  setConversations(key: string, conversations: C[]): void;
  groups(key: string): G[] | undefined;
  setGroups(key: string, groups: G[]): void;
  clear(): void;
}

export function createSlackMetadataCache<C, G>(
  options: SlackMetadataCacheOptions,
): SlackMetadataCache<C, G> {
  const { maxKeys, maxUsersPerKey, ttlMs, now } = options;
  const bundles = new Map<string, Bundle<C, G>>();

  const sweep = (at: number) => {
    for (const [key, bundle] of bundles)
      if (at - bundle.newestAt >= ttlMs) bundles.delete(key);
  };
  /** The key's bundle, made most recent; `undefined` when absent. */
  const read = (key: string) => {
    sweep(now());
    const bundle = bundles.get(key);
    if (bundle) {
      bundles.delete(key);
      bundles.set(key, bundle);
    }
    return bundle;
  };
  /** The key's bundle, made most recent and created when absent. */
  const write = (key: string, at: number) => {
    sweep(at);
    let bundle = bundles.get(key);
    if (bundle) bundles.delete(key);
    else bundle = { newestAt: at, userInfo: new Map() };
    bundles.set(key, bundle);
    while (bundles.size > maxKeys) {
      const oldest = bundles.keys().next().value;
      if (oldest === undefined) break;
      bundles.delete(oldest);
    }
    bundle.newestAt = Math.max(bundle.newestAt, at);
    return bundle;
  };
  const fresh = <T>(stamped: Stamped<T> | undefined, maxAgeMs = ttlMs) =>
    stamped && now() - stamped.fetchedAt < Math.min(maxAgeMs, ttlMs)
      ? stamped.value
      : undefined;
  const insertUser = (
    bundle: Bundle<C, G>,
    userId: string,
    user: SlackCachedUser,
    at: number,
  ) => {
    bundle.userInfo.delete(userId);
    bundle.userInfo.set(userId, { fetchedAt: at, value: user });
    while (bundle.userInfo.size > maxUsersPerKey) {
      const oldest = bundle.userInfo.keys().next().value;
      if (oldest === undefined) break;
      bundle.userInfo.delete(oldest);
    }
  };

  return {
    users: (key) => fresh(read(key)?.users),
    setUsers(key, users) {
      const at = now();
      const bundle = write(key, at);
      const stored = users.map(reduceUser);
      bundle.users = { fetchedAt: at, value: stored };
      for (const user of stored)
        if (user.id) insertUser(bundle, user.id, user, at);
      return stored;
    },
    user: (key, userId) => fresh(read(key)?.userInfo.get(userId)),
    setUser(key, userId, user) {
      const at = now();
      const stored = reduceUser(user);
      insertUser(write(key, at), userId, stored, at);
      return stored;
    },
    conversations: (key, maxAgeMs) => fresh(read(key)?.conversations, maxAgeMs),
    setConversations(key, conversations) {
      const at = now();
      write(key, at).conversations = { fetchedAt: at, value: conversations };
    },
    groups: (key) => fresh(read(key)?.groups),
    setGroups(key, groups) {
      const at = now();
      write(key, at).groups = { fetchedAt: at, value: groups };
    },
    clear: () => bundles.clear(),
  };
}

function reduceUser(user: SlackCachedUser): SlackCachedUser {
  const profile = user.profile
    ? defined<NonNullable<SlackCachedUser["profile"]>>({
        display_name: user.profile.display_name,
        real_name: user.profile.real_name,
        email: user.profile.email,
      })
    : undefined;
  return defined<SlackCachedUser>({
    id: user.id,
    name: user.name,
    real_name: user.real_name,
    deleted: user.deleted,
    tz: user.tz,
    profile,
  });
}

/** The object without its `undefined` members. */
function defined<T extends object>(value: {
  [K in keyof T]: T[K] | undefined;
}): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}
