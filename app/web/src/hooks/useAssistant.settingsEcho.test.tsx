// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ClientMessage,
  ServerMessage,
  SkillToggles,
} from "@assistant/shared";
import { useAssistant } from "./useAssistant.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class EchoSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: EchoSocket[] = [];
  readyState = EchoSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    EchoSocket.instances.push(this);
  }

  open(): void {
    this.readyState = EchoSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(source: string): void {
    this.sent.push(JSON.parse(source) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

let root: Root | null = null;
let latest: ReturnType<typeof useAssistant> | null = null;

function Harness() {
  latest = useAssistant({ isolated: true });
  return null;
}

function readyMessage(): ServerMessage {
  return {
    type: "ready",
    state: null,
    models: [],
    agents: [],
    sessions: [],
    settings: { skills: {} },
    speechToText: null,
    serverBuild: { version: "test" },
    slashCommands: [],
    contextInfo: null,
  } as unknown as ServerMessage;
}

beforeEach(async () => {
  EchoSocket.instances = [];
  vi.stubGlobal("WebSocket", EchoSocket);
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root!.render(<Harness />);
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latest = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connect(): Promise<EchoSocket> {
  const socket = EchoSocket.instances[0]!;
  await act(async () => socket.open());
  await act(async () => socket.receive(readyMessage()));
  return socket;
}

function writes(socket: EchoSocket) {
  return socket.sent.filter((message) => message.type === "updateSettings");
}

function requestIdOf(socket: EchoSocket, index: number): string {
  const write = writes(socket)[index];
  if (write?.type !== "updateSettings" || !write.requestId)
    throw new Error(`no settings write #${index}`);
  return write.requestId;
}

/**
 * One write's answer, in the order the server really produces it: the settings
 * echo comes out of `onUpdateSettings`, then `handle` sends the settle naming
 * the request (`app/server/src/connection.ts`). Tests that skip the settle are
 * testing an echo that never says which write it belongs to.
 */
async function answer(
  socket: EchoSocket,
  requestId: string,
  skills: SkillToggles,
): Promise<void> {
  await act(async () => {
    socket.receive({
      type: "settings",
      settings: { skills } as unknown as AppSettings,
    });
    socket.receive({ type: "mutationSettled", requestId } as ServerMessage);
  });
}

it("does not reduce a skills write until the settings echo arrives", async () => {
  const socket = await connect();

  expect(latest!.state.settings.skills).toEqual({});

  await act(async () => latest!.actions.setSkillEnabled("notes", true));

  expect(latest!.state.settings.skills).toEqual({});
  const [update] = writes(socket);
  if (update?.type !== "updateSettings")
    throw new Error("missing settings write");
  expect(update.patch).toEqual({ skills: { notes: "on" } });
  expect(update.requestId).toBeTypeOf("string");

  await act(async () => {
    socket.receive({
      type: "mutationSettled",
      requestId: update.requestId!,
    } as ServerMessage);
    socket.receive({
      type: "settings",
      settings: { skills: { notes: "on" } } as unknown as AppSettings,
    });
  });

  expect(latest!.state.settings.skills).toEqual({ notes: "on" });
});

it("keeps an earlier toggle when the next one is made before the echo", async () => {
  // The write REPLACES the whole section, and the displayed map deliberately
  // does not move until the echo — so a second toggle built on it would send a
  // replacement without the first skill and turn it back off.
  const socket = await connect();

  await act(async () => latest!.actions.setSkillEnabled("notes", true));
  await act(async () => latest!.actions.setSkillEnabled("triage", true));

  expect(writes(socket).map((write) => write.patch)).toEqual([
    { skills: { notes: "on" } },
    { skills: { notes: "on", triage: "on" } },
  ]);
  // Still nothing claimed on screen: both wait for the server.
  expect(latest!.state.settings.skills).toEqual({});

  await act(async () =>
    socket.receive({
      type: "settings",
      settings: {
        skills: { notes: "on", triage: "on" },
      } as unknown as AppSettings,
    }),
  );

  expect(latest!.state.settings.skills).toEqual({ notes: "on", triage: "on" });
});

it("turning a pending skill back off does not resurrect it", async () => {
  const socket = await connect();

  await act(async () => latest!.actions.setSkillEnabled("notes", true));
  await act(async () => latest!.actions.setSkillEnabled("notes", false));

  expect(writes(socket).at(-1)?.patch).toEqual({ skills: { notes: "off" } });
});

it("starts from the echo again once the server has answered", async () => {
  // With nothing left in flight the echo is the better base, even when it
  // disagrees with what was sent: the server drops entries it will not store,
  // and the next write must not put one back.
  const socket = await connect();

  await act(async () => latest!.actions.setSkillEnabled("notes", true));
  await answer(socket, requestIdOf(socket, 0), {});
  await act(async () => latest!.actions.setSkillEnabled("triage", true));

  expect(writes(socket).at(-1)?.patch).toEqual({ skills: { triage: "on" } });
});

it("an earlier write's answer does not discard a later write's base", async () => {
  // Writes overlap, and each is echoed as it lands. The settings A produced are
  // therefore already behind what the browser has sent, so treating A's answer
  // as "the server has caught up" would build the next write without B — and
  // the whole-section replacement would turn B back off.
  const socket = await connect();

  await act(async () => latest!.actions.setSkillEnabled("notes", true));
  await act(async () => latest!.actions.setSkillEnabled("triage", true));
  const [notesWrite, triageWrite] = [
    requestIdOf(socket, 0),
    requestIdOf(socket, 1),
  ];

  // A lands, A is answered — B is still out there.
  await answer(socket, notesWrite, { notes: "on" });
  await act(async () => latest!.actions.setSkillEnabled("digest", true));

  expect(writes(socket).at(-1)?.patch).toEqual({
    skills: { notes: "on", triage: "on", digest: "on" },
  });

  // B's answer arrives late and is equally stale: C is newer still.
  await answer(socket, triageWrite, { notes: "on", triage: "on" });
  await act(async () => latest!.actions.setSkillEnabled("plan", true));

  expect(writes(socket).at(-1)?.patch).toEqual({
    skills: { notes: "on", triage: "on", digest: "on", plan: "on" },
  });
});

it("stops re-asserting a write the server refused", async () => {
  // A refusal is an answer too. Keeping the refused map as the base would put
  // the rejected change back into every later write, behind the user's back.
  const socket = await connect();

  await act(async () => latest!.actions.setSkillEnabled("notes", true));
  await act(async () =>
    socket.receive({
      type: "error",
      message: "Failed to save settings: EACCES",
      requestId: requestIdOf(socket, 0),
    } as ServerMessage),
  );
  await act(async () => latest!.actions.setSkillEnabled("triage", true));

  expect(writes(socket).at(-1)?.patch).toEqual({ skills: { triage: "on" } });
  expect(latest!.state.settings.skills).toEqual({});
});
