import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { DATA_DIR } from "./config.ts";
import { updateContext7Settings } from "./context7Settings.ts";
import { SecretDestinationError, secretStore } from "./secretStore.ts";

const SEARCH = "https://context7.com/api/v2/libs/search";

afterEach(() => {
  updateContext7Settings({ enabled: false, clearApiKey: true });
});

test("a secret is read for its stored origin, trimmed", async () => {
  updateContext7Settings({ enabled: true, apiKey: "  k1  " });
  assert.equal(await secretStore.read("context7.apiKey", SEARCH), "k1");
  assert.equal(
    await secretStore.read("context7.apiKey", new URL(SEARCH)),
    "k1",
  );
});

test("any other origin is refused without the value", async () => {
  updateContext7Settings({ enabled: true, apiKey: "k1" });
  for (const destination of [
    "https://evil.example/x",
    "http://context7.com/",
    "https://context7.com:8443/api/v2",
    "not a url",
  ])
    await assert.rejects(
      secretStore.read("context7.apiKey", destination),
      (error: unknown) => {
        assert.ok(error instanceof SecretDestinationError, destination);
        assert.match(error.message, /context7\.apiKey/);
        assert.doesNotMatch(error.message, /k1/);
        return true;
      },
    );
});

test("an unset or blank secret reads as absent", async () => {
  updateContext7Settings({ enabled: true, apiKey: "k1" });
  updateContext7Settings({ clearApiKey: true });
  assert.equal(await secretStore.read("context7.apiKey", SEARCH), undefined);
  const dir = join(DATA_DIR, "settings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "context7.json"),
    JSON.stringify({ enabled: true, apiKey: "   " }),
  );
  assert.equal(await secretStore.read("context7.apiKey", SEARCH), undefined);
});
