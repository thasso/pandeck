import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vitest";
import type { ServerMessage } from "@assistant/shared";

const tmp = mkdtempSync(join(tmpdir(), "connection-speech-settings-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");
mkdirSync(join(tmp, "data", "settings"), { recursive: true });
writeFileSync(
  join(tmp, "data", "settings", "app.json"),
  JSON.stringify({
    speechToText: { enabled: false },
    speechConversation: { enabled: true, endpointSilenceSeconds: 1.8 },
    speechSynthesis: { enabled: false, voice: "bm_lewis", speed: 1.2 },
  }),
);

const { Connection } = await import("./connection.ts");
const { getSettings } = await import("./settings.ts");
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("F1: reload projects every composer speech setting, including disabled synthesis", async () => {
  const sent: ServerMessage[] = [];
  const connection = new Connection({
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0]);
  try {
    await connection.init();
    const ready = sent.find((message) => message.type === "ready");
    assert.ok(ready?.type === "ready");
    const settings = getSettings();
    for (const group of [
      "speechToText",
      "speechConversation",
      "speechSynthesis",
      "models",
      "knowledgeBase",
    ] as const)
      assert.deepEqual(ready.settings[group], settings[group], group);
    assert.equal(ready.settings.speechSynthesis?.enabled, false);

    // Explicit reads and live settings echoes must agree with a fresh reload.
    await connection.handle({ type: "requestSettings" });
    connection.settingsChanged({ sections: ["speechSynthesis"] });
    const echoes = sent.filter((message) => message.type === "settings");
    assert.equal(echoes.length, 2);
    for (const message of echoes)
      for (const group of [
        "speechToText",
        "speechConversation",
        "speechSynthesis",
      ] as const)
        assert.deepEqual(message.settings[group], settings[group], group);
  } finally {
    connection.dispose();
  }
});
