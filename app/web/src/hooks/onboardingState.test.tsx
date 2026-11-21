// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSettings,
  ModelOption,
  OnboardingState,
  ServerMessage,
} from "@assistant/shared";
import { writeAppShellCacheRecord } from "../lib/appShellCacheStore.ts";
import type { CredentialProfileProjection } from "../lib/credentialProfiles.ts";
import { dataOf } from "../lib/loadState.ts";
import { mount } from "../test/mount.tsx";
import {
  createInitialState,
  reduceAssistantState,
  useAssistant,
} from "./useAssistant.ts";
import { useCredentialProfileProjection } from "./useCredentialProfileProjection.ts";

function ready(onboarding: OnboardingState): ServerMessage {
  return {
    type: "ready",
    state: null,
    models: [],
    agents: [],
    settings: {},
    speechToText: null,
    serverBuild: { version: "test" },
    slashCommands: [],
    contextInfo: null,
    onboarding,
  } as unknown as ServerMessage;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("first run comes only from the live server", () => {
  it("a cached boot of a complete install never says first run, even with no usable accounts cached", () => {
    writeAppShellCacheRecord({
      version: 1,
      savedAt: Date.now(),
      models: [],
      agents: [],
      sessions: [],
      settings: {},
      slashCommands: [],
      // The negative projection that used to flash the welcome screen.
      credentialProfileProjection: { profiles: [], modelsByProfile: {} },
    });
    const cached = createInitialState();
    expect(cached.hydrationSource).toBe("cache");
    expect(cached.onboarding).toBeNull();
    const live = reduceAssistantState(cached, {
      kind: "server",
      msg: ready("complete"),
    });
    expect(live.onboarding).toBe("complete");
  });

  it("follows the server from pending through setup to complete", () => {
    const pending = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: ready("pending"),
    });
    expect(pending.onboarding).toBe("pending");
    const setup = reduceAssistantState(pending, {
      kind: "server",
      msg: { type: "onboarding", state: "setup" },
    });
    expect(setup.onboarding).toBe("setup");
    const done = reduceAssistantState(setup, {
      kind: "server",
      msg: { type: "onboarding", state: "complete" },
    });
    expect(done.onboarding).toBe("complete");
  });

  it("a reload during setup reads setup from ready", () => {
    const live = reduceAssistantState(createInitialState(), {
      kind: "server",
      msg: ready("setup"),
    });
    expect(live.onboarding).toBe("setup");
  });
});

class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    Socket.instances.push(this);
  }
  open(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function AssistantHarness() {
  useAssistant({ isolated: true });
  return null;
}

describe("the Claude SDK handover", () => {
  it("re-reads accounts when the SERVER confirms the switch changed, once per change", async () => {
    Socket.instances = [];
    vi.stubGlobal("WebSocket", Socket);
    const invalidations = vi.fn();
    window.addEventListener("credentialProfilesChanged", invalidations);
    try {
      await act(async () => {
        mount(<AssistantHarness />);
        await Promise.resolve();
      });
      const socket = Socket.instances[0]!;
      await act(async () => {
        socket.open();
        socket.receive(ready("pending"));
      });
      const settings = (enabled: boolean): ServerMessage => ({
        type: "settings",
        settings: { claudeSdk: { enabled } } as AppSettings,
      });
      await act(async () => socket.receive(settings(true)));
      expect(invalidations).toHaveBeenCalledTimes(1);
      // An echo of the same value is not a change.
      await act(async () => socket.receive(settings(true)));
      expect(invalidations).toHaveBeenCalledTimes(1);
      await act(async () => socket.receive(settings(false)));
      expect(invalidations).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("credentialProfilesChanged", invalidations);
    }
  });

  it("an invalidation reads afresh instead of joining a read that predates the switch", async () => {
    const claude = {
      id: "cp_claude",
      name: "Claude",
      provider: "claude",
      enabled: true,
      enterprise: false,
      status: "ready",
      health: { state: "unknown", since: null },
      createdAt: 1,
      updatedAt: 1,
    };
    const opus: ModelOption = {
      provider: "claude-sdk",
      id: "opus",
      name: "Claude Opus",
      reasoning: true,
      contextWindow: 200_000,
    };
    const answer = (models: ModelOption[]) =>
      new Response(
        JSON.stringify({
          profiles: [claude],
          modelsByProfile: { cp_claude: models },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    // The read before the switch is still on its way when the switch lands.
    let answerBefore!: (response: Response) => void;
    const before = new Promise<Response>((done) => (answerBefore = done));
    const fetches = vi
      .fn<() => Promise<Response>>()
      .mockImplementationOnce(() => before)
      .mockImplementation(async () => answer([opus]));
    vi.stubGlobal("fetch", fetches);

    let latest: CredentialProfileProjection | undefined;
    function ProjectionHarness() {
      const fetch = useCredentialProfileProjection({
        connected: true,
        onProjection: () => {},
      });
      latest = dataOf(fetch.state);
      return null;
    }
    await act(async () => {
      mount(<ProjectionHarness />);
      await Promise.resolve();
    });
    expect(fetches).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("credentialProfilesChanged"));
      await Promise.resolve();
    });
    expect(fetches).toHaveBeenCalledTimes(2);
    await act(async () => {
      answerBefore(answer([]));
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(latest?.modelsByProfile.cp_claude).toEqual([opus]);
  });
});
