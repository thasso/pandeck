import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";
import type { BroadcastTopic, ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "skills-subscribe-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const { validateClientMessage } = await import("./validateClientMessage.ts");
const { SKILLS_LIBRARY_DIR } = await import("./config.ts");
const { setSkillLibraryBroadcaster } =
  await import("./skills/skillLibraryEvents.ts");

afterAll(() => {
  setSkillLibraryBroadcaster({ broadcast: () => {} });
  rmSync(tmp, { recursive: true, force: true });
});

function makeConnection() {
  const sent: ServerMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (source: string) => sent.push(JSON.parse(source) as ServerMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs);
  return { connection, sent };
}

test("the skills topic is a known subscription", () => {
  assert.equal(
    validateClientMessage({ type: "subscribe", topics: ["skills"] }).ok,
    true,
  );
});

test("subscribing scans the library and answers through the topic seam", async () => {
  await mkdir(join(SKILLS_LIBRARY_DIR, "review-pass"), { recursive: true });
  await writeFile(
    join(SKILLS_LIBRARY_DIR, "review-pass", "SKILL.md"),
    "---\nname: review-pass\ndescription: Review a change.\n---\n\nBody.\n",
    "utf8",
  );
  const broadcasts: ServerMessage[] = [];
  setSkillLibraryBroadcaster({
    broadcast: (message) => broadcasts.push(message),
  });
  const { connection, sent } = makeConnection();
  const subscribe = (
    connection as unknown as {
      onSubscribe: (topics: BroadcastTopic[]) => void;
    }
  ).onSubscribe.bind(connection);

  subscribe(["skills"]);
  // Session-start resolution now scans this same working tree too. Under the
  // full parallel suite the filesystem pool can be busy, so wait for the
  // promised publish rather than assuming one scan always finishes in 50 ms.
  await vi.waitFor(() => assert.equal(broadcasts.length, 1), {
    timeout: 2_000,
    interval: 10,
  });

  // The answer travels on the topic, not as a private per-connection shape:
  // every window showing the library sees the same authoritative scan.
  assert.equal(
    sent.filter((message) => message.type === "skillList").length,
    0,
  );
  assert.equal(broadcasts.length, 1);
  const message = broadcasts[0];
  assert.ok(message?.type === "skillList");
  assert.deepEqual(message.list?.skills, [
    {
      name: "review-pass",
      description: "Review a change.",
      path: "review-pass/SKILL.md",
    },
  ]);

  // Re-subscribing is a no-op while the topic is already held; the fresh scan
  // belongs to the transition into the surface.
  subscribe(["skills"]);
  assert.equal(broadcasts.length, 1);
});
