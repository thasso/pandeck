import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  createSlackMetadataCache,
  type SlackCachedUser,
} from "./slackMetadataCache.ts";

/** Caps small enough to reach: 3 callers, 4 users each, values fresh for 1 s. */
function smallCache() {
  const clock = { now: 0 };
  const cache = createSlackMetadataCache<{ id: string }, { id: string }>({
    maxKeys: 3,
    maxUsersPerKey: 4,
    ttlMs: 1000,
    now: () => clock.now,
  });
  return { clock, cache };
}
const users = (...ids: string[]): SlackCachedUser[] =>
  ids.map((id) => ({ id, name: id.toLowerCase() }));
const present = (value: unknown) => value !== undefined;

describe("Slack metadata cache", () => {
  test("creating a fourth caller drops the least recently touched one", () => {
    const { cache } = smallCache();
    cache.setConversations("k1", [{ id: "C1" }]);
    cache.setConversations("k2", [{ id: "C2" }]);
    cache.setConversations("k3", [{ id: "C3" }]);
    assert.deepEqual(cache.conversations("k1", 1000), [{ id: "C1" }]);
    cache.setConversations("k4", [{ id: "C4" }]);

    assert.equal(cache.conversations("k2", 1000), undefined);
    assert.deepEqual(cache.conversations("k1", 1000), [{ id: "C1" }]);
    assert.deepEqual(cache.conversations("k3", 1000), [{ id: "C3" }]);
    assert.deepEqual(cache.conversations("k4", 1000), [{ id: "C4" }]);
  });

  test("seeding more users than a caller may hold keeps the newest", () => {
    const { cache } = smallCache();
    cache.setUsers("k", users("U1", "U2", "U3", "U4", "U5", "U6"));

    assert.deepEqual(
      ["U1", "U2", "U3", "U4", "U5", "U6"].map((id) =>
        present(cache.user("k", id)),
      ),
      [false, false, true, true, true, true],
    );
    // The users.list answer itself is kept whole.
    assert.equal(cache.users("k")?.length, 6);
  });

  test("users from users.info and from seeding share one insertion order", () => {
    const { cache } = smallCache();
    cache.setUsers("k", users("U1", "U2", "U3", "U4"));
    cache.setUser("k", "U5", { id: "U5" });
    cache.setUser("k", "U6", { id: "U6" });
    assert.deepEqual(
      ["U1", "U2", "U3", "U4", "U5", "U6"].map((id) =>
        present(cache.user("k", id)),
      ),
      [false, false, true, true, true, true],
    );

    // Storing U3 again makes it the newest, so U4 is now the oldest.
    cache.setUser("k", "U3", { id: "U3" });
    cache.setUser("k", "U7", { id: "U7" });
    assert.deepEqual(
      ["U3", "U4", "U5", "U6", "U7"].map((id) => present(cache.user("k", id))),
      [true, false, true, true, true],
    );
  });

  test("a value answers until, not at, ttlMs after it was fetched", () => {
    const { clock, cache } = smallCache();
    cache.setConversations("k", [{ id: "C1" }]);
    cache.setGroups("k", [{ id: "S1" }]);
    cache.setUser("k", "U1", { id: "U1" });
    cache.setUsers("k", users("U2"));

    clock.now = 999;
    assert.ok(present(cache.conversations("k", 1000)));
    assert.ok(present(cache.groups("k")));
    assert.ok(present(cache.user("k", "U1")));
    assert.ok(present(cache.users("k")));

    clock.now = 1000;
    assert.equal(cache.conversations("k", 1000), undefined);
    assert.equal(cache.groups("k"), undefined);
    assert.equal(cache.user("k", "U1"), undefined);
    assert.equal(cache.users("k"), undefined);
  });

  test("freshness is per value: a newer value keeps the caller, not the older ones", () => {
    const { clock, cache } = smallCache();
    cache.setConversations("k", [{ id: "C1" }]);
    cache.setGroups("k", [{ id: "S1" }]);
    cache.setUser("k", "U1", { id: "U1" });
    cache.setUsers("k", users("U2"));
    clock.now = 600;
    cache.setUser("k", "U3", { id: "U3" });

    // At 1000 the values fetched at 0 miss; U3 (600) keeps the caller.
    clock.now = 1000;
    assert.equal(cache.conversations("k", 1000), undefined);
    assert.equal(cache.groups("k"), undefined);
    assert.equal(cache.user("k", "U1"), undefined);
    assert.equal(cache.user("k", "U2"), undefined);
    assert.equal(cache.users("k"), undefined);
    assert.deepEqual(cache.user("k", "U3"), { id: "U3" });

    clock.now = 1599;
    assert.deepEqual(cache.user("k", "U3"), { id: "U3" });
    clock.now = 1600;
    assert.equal(cache.user("k", "U3"), undefined);
  });

  test("the conversation list also honours the caller's maximum age", () => {
    const { clock, cache } = smallCache();
    cache.setConversations("k", [{ id: "C1" }]);
    assert.equal(cache.conversations("k", 0), undefined);
    clock.now = 499;
    assert.ok(present(cache.conversations("k", 500)));
    clock.now = 500;
    assert.equal(cache.conversations("k", 500), undefined);
    // A maximum age past the TTL does not extend it.
    clock.now = 1000;
    assert.equal(cache.conversations("k", 60_000), undefined);
  });

  test("an expired caller is removed on the next access to any other caller", () => {
    const { clock, cache } = smallCache();
    cache.setConversations("k1", [{ id: "C1" }]);
    clock.now = 600;
    cache.setConversations("k2", [{ id: "C2" }]);
    cache.setConversations("k3", [{ id: "C3" }]);
    clock.now = 900;
    // k1 is now the most recently touched caller, still fresh.
    assert.ok(present(cache.conversations("k1", 1000)));

    clock.now = 1000;
    assert.ok(present(cache.conversations("k2", 1000)));
    cache.setConversations("k4", [{ id: "C4" }]);
    // Had expired k1 still held a slot, creating k4 would have dropped k3.
    assert.ok(present(cache.conversations("k3", 1000)));
    assert.ok(present(cache.conversations("k4", 1000)));
  });

  test("stored users hold only the fields the read core reads", () => {
    const { cache } = smallCache();
    const raw = {
      id: "U1",
      name: "ada",
      real_name: "Ada Lovelace",
      deleted: false,
      tz: "Europe/London",
      is_admin: true,
      profile: {
        display_name: "ada",
        real_name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "+44 0000",
        image_72: "https://example.com/ada.png",
      },
    };
    const reduced = {
      id: "U1",
      name: "ada",
      real_name: "Ada Lovelace",
      deleted: false,
      tz: "Europe/London",
      profile: {
        display_name: "ada",
        real_name: "Ada Lovelace",
        email: "ada@example.com",
      },
    };
    assert.deepEqual(cache.setUser("k", "U1", raw), reduced);
    assert.deepEqual(cache.user("k", "U1"), reduced);
    cache.setUsers("k", [{ ...raw, id: "U2" }]);
    assert.deepEqual(cache.user("k", "U2"), { ...reduced, id: "U2" });
    assert.deepEqual(cache.users("k"), [{ ...reduced, id: "U2" }]);
  });

  test("clear forgets every caller", () => {
    const { cache } = smallCache();
    cache.setConversations("k", [{ id: "C1" }]);
    cache.clear();
    assert.equal(cache.conversations("k", 1000), undefined);
  });
});
