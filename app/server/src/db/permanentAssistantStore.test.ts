import assert from "node:assert/strict";
import { test } from "vitest";
import { permanentAssistantStore } from "./permanentAssistantStore.ts";

test("permanent assistant store binds one session and de-duplicates FIFO messages", () => {
  permanentAssistantStore.setSessionId("session-permanent");
  assert.equal(permanentAssistantStore.sessionId(), "session-permanent");
  permanentAssistantStore.clearSessionId();
  assert.equal(permanentAssistantStore.sessionId(), undefined);
  permanentAssistantStore.setSessionId("session-permanent");

  const key = `web:${Date.now()}:dedupe`;
  const first = permanentAssistantStore.enqueue({
    dedupeKey: key,
    source: "web",
    text: "first",
  });
  const duplicate = permanentAssistantStore.enqueue({
    dedupeKey: key,
    source: "web",
    text: "ignored duplicate",
  });
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.text, "first");

  permanentAssistantStore.mark(first.id, "working");
  permanentAssistantStore.recover();
  const recovered = permanentAssistantStore.next();
  assert.equal(recovered?.id, first.id);
  assert.equal(recovered?.status, "queued");
  assert.equal(recovered?.attempts, 1);
  permanentAssistantStore.mark(first.id, "completed");
});
