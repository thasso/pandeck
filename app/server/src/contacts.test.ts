/**
 * Contacts domain: id derivation, normalization, identity-based merge, field
 * corrections, and lookup. Isolated temp data dir (own SQLite).
 *   pnpm --filter @assistant/server test src/contacts.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "contacts-test-"));
process.env.ASSISTANT_CWD = tmp;

const {
  upsertContact,
  setContactFields,
  lookupContacts,
  getContact,
  deleteContact,
  projectContact,
} = await import("./contacts.ts");
const { contactStore } = await import("./db/contactStore.ts");

beforeEach(() => {
  contactStore.resetForTests();
});

test("create requires a name and derives a stable id", () => {
  assert.throws(() => upsertContact({ roles: ["x"] }), /requires a name/);
  const { contact, created } = upsertContact({
    name: "Sam Rivera",
    roles: ["People Lead"],
    areas: ["people", "resources"],
  });
  assert.equal(created, true);
  assert.match(contact.id, /^sam-rivera-[0-9a-f]{6}$/);
  assert.deepEqual(contact.roles, ["People Lead"]);
  assert.deepEqual(contact.areas, ["people", "resources"]);
});

test("upsert merges by identity: unions arrays/ids, keeps id, dedups", () => {
  const first = upsertContact({
    name: "Sam",
    email: "Sam@Acme.test",
    areas: ["people"],
  });
  assert.equal(first.created, true);

  // Re-observe by the SAME email (different case) with new info — should merge, not create.
  const second = upsertContact({
    name: "Sam Rivera",
    email: "sam@acme.test",
    jiraId: "acc-1",
    roles: ["People Lead"],
    areas: ["people", "resources"],
  });
  assert.equal(second.created, false);
  assert.equal(second.merged, true);
  assert.equal(second.contact.id, first.contact.id);
  assert.equal(second.contact.email, "sam@acme.test");
  assert.equal(second.contact.jiraId, "acc-1");
  assert.deepEqual(second.contact.roles, ["People Lead"]);
  assert.deepEqual(second.contact.areas, ["people", "resources"]); // "people" not duplicated
  assert.equal(second.contact.name, "Sam Rivera"); // scalar overwrite

  assert.equal(contactStore.listAll().length, 1);
});

test("explicit id targets an existing contact and rejects a missing one", () => {
  const { contact } = upsertContact({ name: "Bob", slackId: "U1" });
  const updated = upsertContact({ id: contact.id, notes: "prefers async" });
  assert.equal(updated.contact.notes, "prefers async");
  assert.equal(updated.contact.slackId, "U1");
  assert.throws(
    () => upsertContact({ id: "nope", name: "x" }),
    /No contact with id/,
  );
});

test("setFields REPLACES roles/areas (correction), unlike upsert union", () => {
  const { contact } = upsertContact({
    name: "Carol",
    roles: ["Dev"],
    areas: ["a", "b"],
  });
  const corrected = setContactFields(contact.id, { areas: ["c"] });
  assert.deepEqual(corrected.areas, ["c"]);
  assert.deepEqual(corrected.roles, ["Dev"]); // untouched when omitted
});

test("lookup by identity, area, and free-text query", () => {
  const ang = upsertContact({
    name: "Sam Rivera",
    email: "sam@acme.test",
    jiraId: "acc-1",
    areas: ["resources"],
    roles: ["People Lead"],
  }).contact;
  upsertContact({ name: "Dan Dev", slackId: "U2", areas: ["android"] });

  assert.deepEqual(
    lookupContacts({ email: "SAM@acme.test" }).map((c) => c.id),
    [ang.id],
  );
  assert.deepEqual(
    lookupContacts({ jiraId: "acc-1" }).map((c) => c.id),
    [ang.id],
  );
  assert.deepEqual(
    lookupContacts({ area: "resources" }).map((c) => c.id),
    [ang.id],
  );
  assert.deepEqual(
    lookupContacts({ query: "people lead" }).map((c) => c.id),
    [ang.id],
  );
  assert.equal(lookupContacts({ query: "nonexistentterm" }).length, 0);
});

test("delete removes and projection drops empty fields", () => {
  const { contact } = upsertContact({ name: "Eve" });
  assert.deepEqual(projectContact(contact), { id: contact.id, name: "Eve" });
  assert.equal(deleteContact(contact.id), true);
  assert.equal(getContact(contact.id), null);
  assert.equal(deleteContact(contact.id), false);
});
