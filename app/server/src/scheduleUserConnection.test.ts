import assert from "node:assert/strict";
import type { ClientMessage, ServerMessage } from "@assistant/shared";
import type { ScheduleActor } from "@assistant/shared/schedules";
import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { Connection } from "./connection.ts";
import { scheduleStore } from "./db/scheduleStore.ts";
import { getSettings } from "./settings.ts";
import {
  resetScheduleTools,
  seedSession,
  useSettings,
} from "./test/scheduleToolsFixture.ts";

/**
 * `saveSettings` with a gate: the real save runs first, synchronous write
 * included, and the returned promise settles only when the test opens the
 * gate, or rejects with `fail`.
 */
const control = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  fail: undefined as Error | undefined,
}));
vi.mock("./settingsService.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settingsService.ts")>();
  return {
    ...actual,
    saveSettings: async (
      patch: Parameters<typeof actual.saveSettings>[0],
    ): ReturnType<typeof actual.saveSettings> => {
      const done = actual.saveSettings(patch);
      if (control.gate) await control.gate;
      if (control.fail) throw control.fail;
      return done;
    },
  };
});

function fakeSocket(sent: ServerMessage[]) {
  return {
    OPEN: 1,
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ConstructorParameters<typeof Connection>[0];
}

type Sent<T extends ServerMessage["type"]> = Extract<
  ServerMessage,
  { type: T }
>;

let sent: ServerMessage[];
let connection: Connection;
let agent: string;

beforeEach(async () => {
  control.gate = undefined;
  control.fail = undefined;
  await useSettings();
  agent = seedSession();
  sent = [];
  connection = new Connection(fakeSocket(sent));
});
afterEach(() => {
  connection.dispose();
  resetScheduleTools();
});

/** An agent-controlled daily 09:00 UTC Schedule created now. */
function agentSchedule() {
  const self: ScheduleActor = { kind: "session", sessionId: agent };
  return scheduleStore.create({
    name: "Daily check",
    prompt: "Old prompt",
    timing: { kind: "daily", time: "09:00", timeZone: "UTC" },
    target: { kind: "session", sessionId: agent },
    createdBy: self,
    cardless: true,
  });
}

const types = () => sent.map((message) => message.type);
const ofType = <T extends ServerMessage["type"]>(type: T) =>
  sent.filter((message): message is Sent<T> => message.type === type);

describe("user Schedule commands over the connection", () => {
  it("an edit answers ONE authoritative item before it settles", async () => {
    const s = agentSchedule();
    await connection.handle({
      type: "updateSchedule",
      id: s.id,
      patch: { prompt: "New prompt" },
      requestId: "req-update",
    } as ClientMessage);
    const saved = ofType("scheduleSaved");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.requestId, "req-update");
    assert.equal(saved[0]!.item.prompt, "New prompt");
    assert.deepEqual(saved[0]!.item.controlledBy, { kind: "user" });
    assert.equal(saved[0]!.revision, scheduleStore.revision(s.id));
    assert.ok(!("items" in saved[0]!), "no collection on a mutation reply");
    const reply = types().indexOf("scheduleSaved");
    const settle = types().indexOf("mutationSettled");
    assert.ok(reply >= 0 && settle > reply, types().join(","));
  });

  it("a refusal is a stamped error naming the Schedule, and never settles", async () => {
    const s = agentSchedule();
    const revision = scheduleStore.revision(s.id);
    await connection.handle({
      type: "updateSchedule",
      id: s.id,
      patch: { timing: { kind: "once", date: "2020-01-01", time: "09:00" } },
      requestId: "req-refused",
    } as ClientMessage);
    const [error] = ofType("error");
    assert.deepEqual(
      { ...error },
      {
        type: "error",
        message:
          "Failed to update Schedule: Schedule timing has no future occurrence",
        target: { type: "schedule", id: s.id },
        requestId: "req-refused",
      },
    );
    assert.deepEqual(types(), ["error"]);
    assert.equal(scheduleStore.revision(s.id), revision);
  });

  it("an on/off that changes nothing still answers, then settles", async () => {
    const s = agentSchedule();
    for (const requestId of ["req-on-1", "req-on-2"])
      await connection.handle({
        type: "setScheduleEnabled",
        id: s.id,
        enabled: true,
        requestId,
      } as ClientMessage);
    assert.deepEqual(types(), [
      "scheduleSaved",
      "mutationSettled",
      "scheduleSaved",
      "mutationSettled",
    ]);
    const [transfer, noop] = ofType("scheduleSaved");
    assert.deepEqual(transfer!.item.controlledBy, { kind: "user" });
    assert.equal(noop!.revision, transfer!.revision, "the no-op wrote nothing");
    assert.equal(noop!.requestId, "req-on-2");
  });

  it("a refused switch and delete name their verb and the Schedule", async () => {
    await connection.handle({
      type: "setScheduleEnabled",
      id: "sch_missing",
      enabled: false,
      requestId: "req-switch",
    } as ClientMessage);
    await connection.handle({
      type: "deleteSchedule",
      id: "sch_missing",
      requestId: "req-delete",
    } as ClientMessage);
    assert.deepEqual(
      ofType("error").map(({ message, target, requestId }) => ({
        message,
        target,
        requestId,
      })),
      [
        {
          message: "Failed to switch Schedule: Schedule not found: sch_missing",
          target: { type: "schedule", id: "sch_missing" },
          requestId: "req-switch",
        },
        {
          message: "Failed to delete Schedule: Schedule not found: sch_missing",
          target: { type: "schedule", id: "sch_missing" },
          requestId: "req-delete",
        },
      ],
    );
    assert.equal(ofType("mutationSettled").length, 0);
  });

  it("a delete settles through mutationSettled alone", async () => {
    const s = agentSchedule();
    await connection.handle({
      type: "deleteSchedule",
      id: s.id,
      requestId: "req-del",
    } as ClientMessage);
    assert.deepEqual(types(), ["mutationSettled"]);
    assert.equal(scheduleStore.get(s.id), undefined);
  });

  it("history answers its items with the revision, and null once gone", async () => {
    const s = agentSchedule();
    const revision = scheduleStore.revision(s.id);
    await connection.handle({
      type: "getScheduleHistory",
      id: s.id,
      requestId: "req-h1",
    } as ClientMessage);
    scheduleStore.delete(s.id);
    await connection.handle({
      type: "getScheduleHistory",
      id: s.id,
      requestId: "req-h2",
    } as ClientMessage);
    const [live, gone] = ofType("scheduleHistory");
    assert.deepEqual(
      { ...live },
      {
        type: "scheduleHistory",
        id: s.id,
        requestId: "req-h1",
        items: [],
        revision,
      },
    );
    assert.deepEqual(
      { ...gone },
      { type: "scheduleHistory", id: s.id, requestId: "req-h2", items: null },
    );
  });

  describe("Pause all", () => {
    it("settles only after the save completes, keeping the current numbers", async () => {
      await useSettings({ graceWindowMinutes: 5, cardlessLimit: 3 });
      let open!: () => void;
      control.gate = new Promise<void>((resolve) => (open = resolve));
      const handled = connection.handle({
        type: "setSchedulesPaused",
        paused: true,
        requestId: "req-pause",
      } as ClientMessage);
      // The write itself is synchronous: it has landed already.
      assert.equal(scheduleStore.paused(), true);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      assert.equal(ofType("mutationSettled").length, 0, "not before the save");
      open();
      await handled;
      assert.deepEqual(
        ofType("mutationSettled").map((m) => m.requestId),
        ["req-pause"],
      );
      assert.deepEqual(getSettings().schedules, {
        graceWindowMinutes: 5,
        cardlessLimit: 3,
        paused: true,
      });
    });

    it("a rejected save is a stamped error without a target, and never settles", async () => {
      control.fail = new Error("Settings saved, but the clock failed");
      await connection.handle({
        type: "setSchedulesPaused",
        paused: true,
        requestId: "req-pause-fail",
      } as ClientMessage);
      const [error] = ofType("error");
      assert.deepEqual(
        { ...error },
        {
          type: "error",
          message:
            "Failed to save Schedules settings: Settings saved, but the clock failed",
          requestId: "req-pause-fail",
        },
      );
      assert.equal(ofType("mutationSettled").length, 0);
    });
  });
});
