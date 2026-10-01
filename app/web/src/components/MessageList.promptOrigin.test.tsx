// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayMessage } from "@assistant/shared";
import { MessageList } from "./MessageList.tsx";
import type { TranscriptViewPrefs } from "./transcriptView.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const view: TranscriptViewPrefs = {
  showThinking: false,
  showTools: true,
  expandThinking: false,
  expandTools: false,
  wrapToolLines: false,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  container.remove();
});

function render(
  message: DisplayMessage,
  onOpenBackgroundWork?: (taskId: string) => void,
): void {
  act(() =>
    root.render(
      <MessageList
        sessionId="session-1"
        messages={[message]}
        view={view}
        {...(onOpenBackgroundWork ? { onOpenBackgroundWork } : {})}
      />,
    ),
  );
}

it("labels a provider-initiated assistant turn with its system origin", () => {
  const message: DisplayMessage = {
    id: "provider-turn",
    role: "assistant",
    promptOrigin: {
      kind: "system",
      source: "claude-background:item-1",
    },
    blocks: [{ kind: "text", text: "Background work finished." }],
  };

  render(message);

  expect(container.textContent).toContain(
    "System prompt · claude-background:item-1",
  );
  expect(container.textContent).toContain("Background work finished.");
});

function backgroundMessage(
  update: Record<string, unknown>,
  omittedCount?: number,
): DisplayMessage {
  return {
    id: "background-turn",
    role: "user",
    promptOrigin: {
      kind: "system",
      source: "background-completion",
      presentation: {
        kind: "background-work",
        updates: [
          {
            taskId: "bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
            label: "Build web bundle",
            humanLink:
              "/background-tasks?task=bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
            ...update,
          },
        ],
        ...(omittedCount !== undefined ? { omittedCount } : {}),
      },
    },
    blocks: [
      {
        kind: "text",
        text: "Background work updated. Agent-only detail must stay hidden.",
      },
    ],
  } as DisplayMessage;
}

it("rests as one line: the job, and which way it ended as a glyph", () => {
  render(
    backgroundMessage({
      description: "Build web bundle",
      command: "cd app/web && pnpm run build",
      status: "completed",
      exitCode: 0,
      outcomeSummary: "Exited with code 0",
      output: {
        url: "/api/session-artifacts/session-1/output.txt",
        capturedBytes: 12,
      },
    }),
  );

  expect(container.textContent).toContain("Build web bundle");
  // The card only ever appears for a delivered update, and for a supervised
  // process the state IS the exit code: neither word adds anything.
  expect(container.textContent).not.toContain("Completed · exit 0");
  expect(container.textContent).not.toContain("Background work updated");
  expect(container.textContent).not.toContain("Agent-only detail");
  // Everything else waits behind the disclosure, including the output panel,
  // so a closed card fetches nothing.
  expect(container.textContent).not.toContain("cd app/web && pnpm run build");
  expect(container.textContent).not.toContain("Output · 12 B");
  expect(container.textContent).not.toContain("Open in registry");
  // The glyph is what the reader sees; the word is what a screen reader says.
  expect(container.textContent).toContain("Background work, Completed:");
});

it("opens to the command, the output and the registry without moving its top line", () => {
  const onOpenBackgroundWork = vi.fn();
  render(
    backgroundMessage({
      description: "Build web bundle",
      command: "cd app/web && pnpm run build",
      status: "completed",
      exitCode: 0,
      output: {
        url: "/api/session-artifacts/session-1/output.txt",
        capturedBytes: 12,
      },
    }),
    onOpenBackgroundWork,
  );

  const toggle = container.querySelector<HTMLButtonElement>(
    'button[title="Build web bundle"]',
  );
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  act(() => toggle?.click());

  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  // The line the reader clicked is still the line they clicked.
  expect(container.textContent).toContain("Build web bundle");
  expect(container.textContent).toContain("cd app/web && pnpm run build");
  expect(container.textContent).toContain("Output · 12 B");
  expect(container.textContent).not.toContain("Loading output");
  expect(
    container.querySelector('a[href^="/background-tasks?task="]'),
  ).toBeNull();
  const taskButton = container.querySelector<HTMLButtonElement>(
    'button[title="bgw_d7372bf0-c886-4282-8b6d-483b872d8872"]',
  );
  expect(taskButton).not.toBeNull();
  act(() => taskButton?.click());
  expect(onOpenBackgroundWork).toHaveBeenCalledWith(
    "bgw_d7372bf0-c886-4282-8b6d-483b872d8872",
  );
});

it("says how a failure ended once it is opened, and never twice", () => {
  render(
    backgroundMessage({
      label: "Run the gate",
      description: "Run the gate",
      command: "pnpm run test",
      status: "failed",
      exitCode: 2,
      outcomeSummary: "Exited with code 2",
    }),
  );

  expect(container.textContent).toContain("Background work, Failed:");
  act(() =>
    container
      .querySelector<HTMLButtonElement>('button[title="Run the gate"]')
      ?.click(),
  );
  expect(container.textContent).toContain("Exited with code 2");
  // The server's sentence already carries the code; the card adds no second one.
  expect(container.textContent).not.toContain("exit 2");
});

it("drops the outcome summary that only repeats the job's own title", () => {
  render(
    backgroundMessage({
      label: "Find lucide install anywhere",
      description: "Find lucide install anywhere",
      command: "find / -name lucide-react",
      status: "stopped",
      outcomeSummary: "Find lucide install anywhere",
    }),
  );

  expect(container.textContent).toContain("Background work, Stopped:");
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        'button[title="Find lucide install anywhere"]',
      )
      ?.click(),
  );
  expect(container.textContent).toContain("find / -name lucide-react");
  expect(
    container.textContent?.match(/Find lucide install anywhere/g)?.length,
  ).toBe(1);
});

it("opens to the whole command even where the title was cut from it", () => {
  const command =
    "for pkg in shared server web; do pnpm --filter @assistant/$pkg run build; done";
  render(
    backgroundMessage({
      // No description: the label IS the command's first line, cut at the cap
      // and ellipsized on screen. The body still has to be readable.
      label: command.slice(0, 40),
      command,
      status: "completed",
    }),
  );

  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        `button[title="${command.slice(0, 40)}"]`,
      )
      ?.click(),
  );
  expect(container.textContent).toContain(command);
});

it("does not repeat a short command the visible top line already carries", () => {
  render(
    backgroundMessage({
      // No description, one short line: the title IS the command, and the row
      // shows it whole. Printing it again in the body would say it twice.
      label: "pnpm test",
      command: "pnpm test",
      status: "completed",
    }),
  );

  act(() =>
    container
      .querySelector<HTMLButtonElement>('button[title="pnpm test"]')
      ?.click(),
  );
  expect(container.textContent?.match(/pnpm test/g)?.length).toBe(1);
});

it("repeats a command the top line had to ellipsize", () => {
  const command = "pnpm --filter @assistant/web exec vitest run src/components";
  render(backgroundMessage({ label: command, command, status: "completed" }));

  const toggle = container.querySelector<HTMLButtonElement>(
    `button[title="${command}"]`,
  );
  const title = toggle?.querySelector("span.truncate");
  // jsdom has no layout: state the overflow the browser would have measured.
  Object.defineProperty(title!, "scrollWidth", { value: 600 });
  Object.defineProperty(title!, "clientWidth", { value: 200 });
  act(() => toggle?.click());

  expect(container.textContent?.match(/pnpm --filter/g)?.length).toBe(2);
});

it("repeats a description the top line had to ellipsize, wrapped", () => {
  const description =
    "Watch the deploy log until the systemd unit reports the new release active";
  render(
    backgroundMessage({
      label: description,
      description,
      command: "journalctl -u personal-assistant -f",
      status: "completed",
    }),
  );

  const toggle = container.querySelector<HTMLButtonElement>(
    `button[title="${description}"]`,
  );
  const title = toggle?.querySelector("span.truncate");
  // jsdom has no layout: state the overflow the browser would have measured.
  Object.defineProperty(title!, "scrollWidth", { value: 600 });
  Object.defineProperty(title!, "clientWidth", { value: 200 });
  act(() => toggle?.click());

  // Once in the stable top line, once wrapped in the body — the command block
  // carries the command, and nothing else on the card carries the title.
  expect(container.textContent?.match(/until the systemd unit/g)?.length).toBe(
    2,
  );
});

it("leaves a description the row showed whole out of the body", () => {
  render(
    backgroundMessage({
      label: "Build web bundle",
      description: "Build web bundle",
      command: "pnpm run build",
      status: "completed",
    }),
  );

  act(() =>
    container
      .querySelector<HTMLButtonElement>('button[title="Build web bundle"]')
      ?.click(),
  );
  expect(container.textContent).toContain("pnpm run build");
  expect(container.textContent?.match(/Build web bundle/g)?.length).toBe(1);
});

it("keeps dropped updates visible while the card is closed", () => {
  render(
    backgroundMessage({ status: "completed", command: "pnpm run build" }, 2),
  );

  expect(container.textContent).toContain("2 more updates omitted");
});

it("does not add an origin badge to an ordinary assistant turn", () => {
  render({
    id: "ordinary-turn",
    role: "assistant",
    blocks: [{ kind: "text", text: "Ordinary answer." }],
  });

  expect(container.textContent).toBe("Ordinary answer.");
});
