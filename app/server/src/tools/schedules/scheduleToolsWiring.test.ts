/**
 * The Schedule tools' load-time wiring (T5.9, the tool half): importing the
 * tools module alone registers the admission resolver, so no write it makes
 * can end an attempted occurrence blind. And when a resolver is somehow
 * missing, the store fails closed and the row reports the store's own error.
 * Its own file: it needs a module graph no other import loaded first.
 *   pnpm --filter @assistant/server test src/tools/schedules/scheduleToolsWiring.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

afterEach(async () => {
  (await import("../../test/scheduleToolsFixture.ts")).resetScheduleTools();
});

/** A cold import of the tools module transforms the whole runtime graph. */
const COLD_IMPORT_MS = 120_000;

test(
  "importing the tools module registers the admission resolver",
  async () => {
    const { scheduleStore } = await import("../../db/scheduleStore.ts");
    assert.equal(
      scheduleStore.hasAdmissionResolver(),
      false,
      "nothing registered it before the tools module loaded",
    );
    await import("./scheduleTools.ts");
    assert.equal(scheduleStore.hasAdmissionResolver(), true);
    assert.match(
      readFileSync(join(HERE, "scheduleTools.ts"), "utf8"),
      /^import "\.\.\/\.\.\/schedules\/scheduledPrompts\.ts";$/m,
      "a load-time import, not a call on first use",
    );
  },
  COLD_IMPORT_MS,
);

test("without a resolver a write ending an attempted claim fails its row and changes nothing", async () => {
  const { scheduleStore, ScheduleAdmissionResolverMissingError } =
    await import("../../db/scheduleStore.ts");
  const { resolveScheduledAdmission } =
    await import("../../schedules/scheduledPrompts.ts");
  const f = await import("../../test/scheduleToolsFixture.ts");
  await f.useSettings();
  const me = f.seedSession();
  const id = await f.createDaily(me);
  const plain = await f.createDaily(me);
  const due = f.NOV25_0800 + 60 * f.MINUTE;
  scheduleStore.claimDue(id, due, { graceMs: 60 * f.MINUTE });
  scheduleStore.claimDue(plain, due, { graceMs: 60 * f.MINUTE });
  const [occurrence] = scheduleStore.history(id);
  scheduleStore.markAttempted(occurrence!.id, due);
  f.clock.now = due + 10 * f.MINUTE;
  scheduleStore.setAdmissionResolver(undefined);
  try {
    const [row, other] = await f.manage(me, [
      { operation: "disable", id },
      // A claim never offered to a runtime ends without a resolver.
      { operation: "disable", id: plain },
    ]);
    assert.equal(row!.ok, false);
    assert.equal(
      row!.error,
      new ScheduleAdmissionResolverMissingError(occurrence!.id).message,
    );
    assert.equal(other!.ok, true);
    assert.equal(scheduleStore.history(plain)[0]!.state, "withdrawn");
    assert.equal(scheduleStore.getOccurrence(occurrence!.id)!.state, "claimed");
    assert.equal(scheduleStore.get(id)!.enabled, true);
  } finally {
    scheduleStore.setAdmissionResolver(resolveScheduledAdmission);
  }
});
