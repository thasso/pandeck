/**
 * Global skill toggles ([Task-613](pa://task/613)): what the settings section
 * stores, what it refuses, and what the client is told afterwards.
 *
 * Every assertion here is about the same asymmetry. Turning a skill ON is the
 * only thing a user ever states deliberately, so nothing may invent one: an
 * absent entry, a dirty value and a failed read all have to read OFF. Turning
 * one off, by contrast, is what a bug would do wholesale — the section is
 * replaced whole, so a malformed patch that reached the writer would silently
 * undo every choice the user made — which is why a patch that is not a map is
 * refused rather than normalized into an empty one.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isSkillEnabled,
  type ClientMessage,
  type ServerMessage,
  type SkillToggles,
} from "@assistant/shared";
import { Connection } from "./connection.ts";
import { hub } from "./hub.ts";
import { getSettings, updateSettings } from "./settings.ts";
import { validateClientMessage } from "./validateClientMessage.ts";

test("with nothing stored, every skill is off", () => {
  assert.deepEqual(getSettings().skills, {});
  // The default is a real answer, not a missing one: the read rule says off.
  assert.equal(isSkillEnabled(getSettings().skills, "release-notes"), false);
});

test("a saved map round-trips and replaces the section whole", () => {
  const saved = updateSettings({
    skills: { "release-notes": "on", triage: "off" },
  });
  assert.deepEqual(saved.skills, { "release-notes": "on", triage: "off" });
  assert.deepEqual(getSettings().skills, saved.skills);

  // The next save is the whole map again, so a name the client left out is
  // gone rather than merged — the control must send what it is keeping.
  const replaced = updateSettings({ skills: { triage: "on" } });
  assert.deepEqual(replaced.skills, { triage: "on" });
  assert.deepEqual(getSettings().skills, { triage: "on" });

  // An empty map is a legitimate patch: that is how the last entry goes.
  assert.deepEqual(updateSettings({ skills: {} }).skills, {});
});

test("an entry for a skill the library does not currently declare survives", () => {
  // The library is hand-authored, so a name goes missing during an edit, a
  // rename or a branch switch. Dropping the entry would quietly turn the skill
  // off the moment it came back; nothing here consults the scanner.
  updateSettings({ skills: { "not-scanned-right-now": "on" } });

  assert.equal(
    isSkillEnabled(getSettings().skills, "not-scanned-right-now"),
    true,
  );
});

test("only the two states survive, and only from a name that could exist", () => {
  const dirty = {
    // Kept: both states, said exactly.
    "release-notes": "on",
    triage: "off",
    // Dropped: nothing may be read as "on" that did not say "on".
    "half-on": true,
    shouty: "ON",
    numeric: 1,
    absent: null,
    nested: { state: "on" },
    // Dropped: keys outside the shared skill-name rule can never name a skill.
    "Release Notes": "on",
    "-leading-hyphen": "on",
    "": "on",
    [`${"x".repeat(65)}`]: "on",
  } as unknown as SkillToggles;

  const saved = updateSettings({ skills: dirty });

  assert.deepEqual(saved.skills, { "release-notes": "on", triage: "off" });
  // Storage answers the same way on the next read, not just in this return.
  assert.deepEqual(getSettings().skills, saved.skills);
});

test("a renamed or deleted skill keeps its old entry and starts the new one off", () => {
  // What an agent rename/delete ([Task-633](pa://task/633)) means HERE: the
  // tools move folders and frontmatter, never this map. The old name's entry
  // is the user's decision and survives, and the new name is off because
  // nobody has turned it on — the ordinary missing-skill rule, not a special
  // case, which is why no cross-store migration is attempted.
  updateSettings({ skills: { "release-notes": "on" } });

  const afterRename = getSettings().skills;
  assert.equal(isSkillEnabled(afterRename, "release-notes"), true);
  assert.equal(isSkillEnabled(afterRename, "changelog-notes"), false);
  assert.deepEqual(afterRename, { "release-notes": "on" });
});

test("a patch that is not a map never erases the stored toggles", () => {
  updateSettings({ skills: { "release-notes": "on" } });

  // Defence in depth behind the validator: the normalizer answers a non-map
  // with an empty map, so only a real map may replace the section.
  for (const malformed of ["wipe-me", 7, ["release-notes"], true])
    assert.deepEqual(
      updateSettings({ skills: malformed as unknown as SkillToggles }).skills,
      { "release-notes": "on" },
    );

  // An unrelated save leaves the section alone.
  updateSettings({ browserTools: { headed: true, rawMcpEnabled: false } });
  assert.deepEqual(getSettings().skills, { "release-notes": "on" });
});

test("the wire validator refuses a skills patch that is not a map of states", () => {
  for (const skills of [
    "wipe-me",
    ["release-notes"],
    { "release-notes": true },
    { "release-notes": "ON" },
    { "release-notes": null },
  ])
    assert.equal(
      validateClientMessage({ type: "updateSettings", patch: { skills } }).ok,
      false,
      `expected ${JSON.stringify(skills)} to be rejected`,
    );

  for (const skills of [{}, { "release-notes": "on", triage: "off" }])
    assert.equal(
      validateClientMessage({ type: "updateSettings", patch: { skills } }).ok,
      true,
      `expected ${JSON.stringify(skills)} to be accepted`,
    );
});

test("the settings echo carries what was persisted, not what was sent", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  // The echo reaches every registered connection, the writer included.
  hub.register(connection);

  updateSettings({ skills: {} });
  await connection.handle({
    type: "updateSettings",
    patch: {
      skills: {
        "release-notes": "on",
        // Reaching the handler anyway (an older or hand-rolled client), this
        // must not come back as an enabled skill.
        shouty: "ON",
      },
    },
  } as unknown as ClientMessage);

  const echo = sent.find((message) => message.type === "settings");
  assert.ok(echo && echo.type === "settings", "expected a settings echo");
  assert.deepEqual(echo.settings.skills, { "release-notes": "on" });
  // The echo is the persisted state: it agrees with a fresh read.
  assert.deepEqual(echo.settings.skills, getSettings().skills);

  connection.dispose();
});
