// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
  KOKORO_ENGLISH_VOICES,
  type AppSettings,
} from "@assistant/shared";
import { VoiceSettings } from "./VoiceSettings.tsx";
import {
  FakeSpeechContext,
  flushSpeech,
  wavResponse,
} from "../lib/speechFakes.test-support.ts";

let root: Root;
let container: HTMLDivElement;
const settings = {
  speechConversation: DEFAULT_SPEECH_CONVERSATION_SETTINGS,
  speechSynthesis: DEFAULT_SPEECH_SYNTHESIS_SETTINGS,
} as AppSettings;
const status = {
  configured: false,
  maxUtteranceSeconds: 120,
  availableModelIds: [],
  conversation: { configured: true, availableModelIds: ["nemotron"] },
  tts: {
    configured: true,
    availableVoices: KOKORO_ENGLISH_VOICES.map((voice) => voice.name),
  },
};
const onUpdate = vi.fn();
beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("AudioContext", FakeSpeechContext);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => wavResponse()),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <VoiceSettings settings={settings} status={status} onUpdate={onUpdate} />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("renders shared voices and the conversation model picker", () => {
  const picker =
    container.querySelector<HTMLSelectElement>("#synthesis-voice")!;
  expect(Array.from(picker.options).map((option) => option.value)).toEqual(
    KOKORO_ENGLISH_VOICES.map((voice) => voice.name),
  );
  expect(
    container.querySelector<HTMLSelectElement>("#conversation-model")!
      .options[1]!.value,
  ).toBe("nemotron");
  expect(
    container.querySelector<HTMLInputElement>("#conversation-silence")!.min,
  ).toBe("0.3");
  expect(
    container.querySelector<HTMLInputElement>("#synthesis-speed")!.max,
  ).toBe("2");
});

it("previews local voice/speed choices before the settings echo and cleans up on unmount", async () => {
  const voice = container.querySelector<HTMLSelectElement>("#synthesis-voice")!;
  act(() => {
    voice.value = "bm_lewis";
    voice.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const input = container.querySelector<HTMLInputElement>("#synthesis-speed")!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "1.3");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onUpdate).toHaveBeenLastCalledWith({
    speechSynthesis: {
      ...settings.speechSynthesis,
      voice: "bm_lewis",
      speed: 1.3,
    },
  });
  const button = container.querySelector<HTMLButtonElement>(
    "button:not([role=switch])",
  )!;
  await act(async () => {
    button.click();
    await flushSpeech();
  });
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string),
  ).toMatchObject({ voice: "bm_lewis", speed: 1.3 });
  expect(button.textContent).toBe("Stop preview");
  const context = FakeSpeechContext.instances.at(-1)!;
  act(() => root.unmount());
  expect(context.sources[0]!.stop).toHaveBeenCalledOnce();
  expect(context.close).toHaveBeenCalled();
});

it("shows a host unavailability reason and never fetches when disabled", () => {
  act(() =>
    root.render(
      <VoiceSettings
        settings={settings}
        status={{
          ...status,
          tts: {
            configured: false,
            availableVoices: [],
            reason: "Kokoro is not installed",
          },
        }}
        onUpdate={onUpdate}
      />,
    ),
  );
  expect(container.textContent).toContain("Kokoro is not installed");
  expect(
    container.querySelector<HTMLButtonElement>("button:not([role=switch])")!
      .disabled,
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
