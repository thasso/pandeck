import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composer } from "../../../src/components/Composer.tsx";
import {
  DictationDiscardButton,
  DictationTrace,
  DictationToggleButton,
} from "../../../src/components/DictationControls.tsx";
import {
  InputGroup,
  InputGroupAddon,
} from "../../../src/components/ui/input-group.tsx";
import { PeakRing } from "../../../src/lib/waveform.ts";
import {
  chatActions,
  chatCommands,
  chatModels,
  chatSession,
  noop,
} from "../../fixtures/chat.ts";

type State =
  | "empty"
  | "typed"
  | "attachments"
  | "slash"
  | "model"
  | "streaming"
  | "disabled"
  | "dictation";
function ComposerPreview({
  state,
  frameWidth,
}: {
  state: State;
  frameWidth: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (state === "model")
        host.current
          ?.querySelector<HTMLButtonElement>('button[title="Model"]')
          ?.click();
      if (state === "attachments") {
        const input =
          host.current?.querySelector<HTMLInputElement>('input[type="file"]');
        if (!input) return;
        const transfer = new DataTransfer();
        transfer.items.add(
          new File(["Chat regression notes\n"], "notes.md", {
            type: "text/markdown",
          }),
        );
        transfer.items.add(
          new File(["export const stable = true;"], "composer-runtime.ts", {
            type: "text/typescript",
          }),
        );
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    return () => cancelAnimationFrame(id);
  }, [state]);
  const peaks = useRef(new PeakRing(80));
  useEffect(() => {
    peaks.current.push(
      Array.from(
        { length: 80 },
        (_, i) => 0.15 + Math.abs(Math.sin(i * 0.73)) * 0.6,
      ),
    );
  }, []);
  if (state === "dictation") {
    const dictation = {
      phase: "recording" as const,
      peaks: peaks.current,
      elapsedSeconds: 12,
      uploading: false,
      onToggle: noop,
      onCancel: noop,
    };
    return (
      <div style={{ width: frameWidth, maxWidth: "100%" }} className="p-4">
        <InputGroup>
          <InputGroupAddon align="block-end">
            <DictationTrace dictation={dictation} />
            <DictationDiscardButton onCancel={noop} />
            <DictationToggleButton dictation={dictation} />
          </InputGroupAddon>
        </InputGroup>
      </div>
    );
  }
  const text =
    state === "typed" || state === "attachments"
      ? "Keep transcript rows stable when another session broadcasts an update."
      : state === "slash"
        ? "/"
        : "";
  return (
    <div
      ref={host}
      style={{ width: frameWidth, maxWidth: "100%", minHeight: 520 }}
      className="flex items-end bg-background"
    >
      <Composer
        key={state}
        onSend={noop}
        onAbort={noop}
        onQueue={noop}
        streaming={state === "streaming"}
        disabled={state === "disabled"}
        contextInfo={null}
        session={chatSession}
        models={chatModels}
        slashCommands={chatCommands}
        actions={chatActions}
        draft={{ sessionId: chatSession.sessionId, token: 1, text }}
        draftAutoFocus={false}
      />
    </div>
  );
}
const meta = {
  title: "Chat/Composer",
  component: ComposerPreview,
  parameters: { layout: "fullscreen" },
  args: { frameWidth: 800, state: "empty" },
} satisfies Meta<typeof ComposerPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty = {} satisfies Story;
export const Typed = { args: { state: "typed" } } satisfies Story;
export const Attachments = { args: { state: "attachments" } } satisfies Story;
export const SlashMenu = { args: { state: "slash" } } satisfies Story;
export const ModelPicker = { args: { state: "model" } } satisfies Story;
export const StreamingStop = { args: { state: "streaming" } } satisfies Story;
export const Disabled = { args: { state: "disabled" } } satisfies Story;
export const Dictation = { args: { state: "dictation" } } satisfies Story;
export const Phone = {
  args: { frameWidth: 390, state: "typed" },
  globals: { viewport: { value: "paPhone", isRotated: false } },
} satisfies Story;
