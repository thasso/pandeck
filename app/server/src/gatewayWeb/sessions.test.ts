/**
 * `Sessions` (Task-1402 B2): every way a session leaves the table reports its
 * login actor exactly once, and `live` never extends a session.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { Sessions } from "./sessions.ts";

const HOUR = 60 * 60_000;

function table() {
  let clock = 0;
  const ended: string[] = [];
  const sessions = new Sessions(
    () => clock,
    (actorId) => ended.push(actorId),
  );
  const open = (userId = "u1") => {
    const value = sessions.create(userId)!;
    return { value, actorId: sessions.lookup(value)!.actorId };
  };
  return {
    sessions,
    ended,
    open,
    advance: (ms: number) => (clock += ms),
  };
}

test("the actor id is neither the cookie nor stable across sessions", () => {
  const t = table();
  const a = t.open();
  const b = t.open();
  assert.notEqual(a.actorId, a.value);
  assert.notEqual(a.actorId, b.actorId);
  assert.equal(t.sessions.live(a.actorId), true);
});

test("sign-out reports the actor once", () => {
  const t = table();
  const a = t.open();
  assert.equal(t.sessions.end(a.value), "u1");
  assert.equal(t.sessions.end(a.value), undefined);
  assert.deepEqual(t.ended, [a.actorId]);
  assert.equal(t.sessions.live(a.actorId), false);
});

test("expiry found by a lookup reports the actor once", () => {
  const t = table();
  const a = t.open();
  t.advance(12 * HOUR);
  assert.equal(t.sessions.lookup(a.value), undefined);
  assert.equal(t.sessions.lookup(a.value), undefined);
  assert.deepEqual(t.ended, [a.actorId]);
});

test("expiry found by live reports the actor once", () => {
  const t = table();
  const a = t.open();
  t.advance(2 * HOUR);
  assert.equal(t.sessions.live(a.actorId), false);
  assert.equal(t.sessions.live(a.actorId), false);
  assert.deepEqual(t.ended, [a.actorId]);
});

test("expiry found by the sweep reports the actor once", () => {
  const t = table();
  const a = t.open();
  const b = t.open("u2");
  t.advance(HOUR);
  t.sessions.lookup(b.value);
  t.advance(HOUR);
  t.sessions.sweep();
  t.sessions.sweep();
  assert.deepEqual(t.ended, [a.actorId]);
  assert.equal(t.sessions.live(b.actorId), true);
});

test("a user's 17th session evicts the first and reports it once", () => {
  const t = table();
  const first = t.open();
  for (let i = 0; i < 15; i++) {
    t.advance(1);
    t.open();
  }
  assert.deepEqual(t.ended, []);
  t.advance(1);
  t.open();
  assert.deepEqual(t.ended, [first.actorId]);
  assert.equal(t.sessions.lookup(first.value), undefined);
  assert.deepEqual(t.ended, [first.actorId]);
});

test("live does not refresh the idle clock; a lookup does", () => {
  const t = table();
  const a = t.open();
  t.advance(HOUR);
  assert.equal(t.sessions.live(a.actorId), true);
  t.advance(HOUR);
  assert.equal(t.sessions.live(a.actorId), false);

  const b = t.open();
  t.advance(HOUR);
  assert.ok(t.sessions.lookup(b.value));
  t.advance(HOUR);
  assert.equal(t.sessions.live(b.actorId), true);
});
