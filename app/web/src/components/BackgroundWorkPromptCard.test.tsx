// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundWorkPromptPresentation } from "@assistant/shared/session";
import { BackgroundWorkPromptCard } from "./BackgroundWorkPromptCard.tsx";

type Update = BackgroundWorkPromptPresentation["updates"][number];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function update(overrides: Partial<Update> = {}): Update {
  return {
    taskId: "bgw-build",
    label: "Build web bundle",
    description: "Build web bundle",
    command: "pnpm run build",
    status: "completed",
    humanLink: "/background-work/bgw-build",
    ...overrides,
  };
}

function renderCard(
  updates: Update[],
  props: Omit<
    Parameters<typeof BackgroundWorkPromptCard>[0],
    "presentation"
  > = {},
  omittedCount?: number,
) {
  act(() =>
    root.render(
      <BackgroundWorkPromptCard
        presentation={{
          kind: "background-work",
          updates,
          ...(omittedCount === undefined ? {} : { omittedCount }),
        }}
        {...props}
      />,
    ),
  );
  return [
    ...container.querySelectorAll<HTMLButtonElement>("button[aria-controls]"),
  ];
}

function body(toggle: HTMLButtonElement) {
  return document.getElementById(toggle.getAttribute("aria-controls")!);
}

describe("BackgroundWorkPromptCard", () => {
  it.each([
    ["completed", "Completed", "lucide-circle-check"],
    ["failed", "Failed", "lucide-circle-x"],
    ["stopped", "Stopped", "lucide-circle-slash"],
    ["lost", "Lost", "lucide-triangle-alert"],
    ["activity", "Activity", "lucide-circle-dashed"],
  ] as const)(
    "keeps %s visible as its own shape while collapsed",
    (status, label, icon) => {
      const [toggle] = renderCard([update({ status })]);
      expect(toggle!.getAttribute("aria-expanded")).toBe("false");
      expect(toggle!.getAttribute("aria-label")).toContain(label);
      expect(container.textContent).toContain(label);
      expect(container.querySelector(`.${icon}`)).not.toBeNull();
      if (status !== "completed")
        expect(container.querySelector(".lucide-circle-check")).toBeNull();
      if (status === "failed" || status === "lost")
        expect(container.querySelector(".text-danger")?.textContent).toContain(
          label,
        );
      expect(body(toggle!)).toBeNull();
    },
  );

  it("defers command, output, registry and actions until expansion", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const onOpenBackgroundWork = vi.fn();
    const [toggle] = renderCard(
      [
        update({
          output: {
            url: "/api/session-artifacts/s/output.txt",
            capturedBytes: 12,
            truncated: true,
          },
          commandTruncated: true,
        }),
      ],
      { onOpenBackgroundWork, actions: <button>Copy message</button> },
    );
    expect(container.textContent).not.toContain("pnpm run build");
    expect(container.textContent).not.toContain("Open in registry");
    expect(container.textContent).not.toContain("Output");
    expect(container.textContent).not.toContain("Copy message");
    expect(fetch).not.toHaveBeenCalled();
    act(() => toggle!.click());
    expect(toggle!.getAttribute("aria-expanded")).toBe("true");
    expect(body(toggle!)?.textContent).toContain("pnpm run build");
    expect(body(toggle!)?.textContent).toContain("Cut at");
    expect(body(toggle!)?.textContent).toContain("Output · 12 B · truncated");
    expect(body(toggle!)?.textContent).toContain("Copy message");
    expect(container.querySelector("a")?.getAttribute("href")).toContain(
      "/api/session-artifacts/s/output.txt",
    );
    expect(fetch).not.toHaveBeenCalled();
    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="bgw-build"]')!
        .click(),
    );
    expect(onOpenBackgroundWork).toHaveBeenCalledWith("bgw-build");
    act(() => toggle!.click());
    expect(body(toggle!)).toBeNull();
    expect(container.textContent).not.toContain("Copy message");
  });

  it("shows the job as a plain bounded preview and reveals the outcome only on expansion", () => {
    const label = `**Build bundle**\n\n${"for the next release ".repeat(30)}`;
    const outcomeSummary = "Build failed because the worker ran out of memory";
    const [toggle] = renderCard([
      update({ label, description: label, status: "failed", outcomeSummary }),
    ]);
    expect(container.textContent).toContain("Work");
    expect(container.textContent).toContain("Build bundle");
    expect(container.textContent).toContain("**Build bundle**");
    expect(toggle!.getAttribute("aria-label")).not.toContain("\n");
    expect(container.textContent!.length).toBeLessThan(label.length);
    expect(container.textContent).not.toContain(outcomeSummary);
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).toContain(label);
    expect(body(toggle!)?.textContent).toContain(outcomeSummary);
  });

  it("keeps a failure exit detail when the server supplied no outcome", () => {
    const [toggle] = renderCard([update({ status: "failed", exitCode: 2 })]);
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).toContain("Exited with code 2");
  });

  it("does not repeat a clean exit or an outcome containing only the job title", () => {
    const toggles = renderCard([
      update({ outcomeSummary: "Exited with code 0", exitCode: 0 }),
      update({
        taskId: "bgw-stopped",
        status: "stopped",
        outcomeSummary: "Build web bundle",
      }),
    ]);
    for (const toggle of toggles) act(() => toggle.click());
    expect(container.textContent).not.toContain("Exited with code 0");
    expect(body(toggles[1]!)?.textContent).not.toContain("Build web bundle");
  });

  it("opens rows independently, keeps omitted count visible and actions in the last body", () => {
    const toggles = renderCard(
      [
        update(),
        update({
          taskId: "bgw-test",
          label: "Run tests",
          description: "Run tests",
          status: "failed",
        }),
      ],
      { actions: <button>Copy message</button> },
      3,
    );
    expect(container.textContent).toContain("3 more updates omitted");
    act(() => toggles[0]!.click());
    expect(body(toggles[0]!)).not.toBeNull();
    expect(body(toggles[1]!)).toBeNull();
    expect(container.textContent).not.toContain("Copy message");
    act(() => toggles[1]!.click());
    expect(body(toggles[1]!)?.textContent).toContain("Copy message");
    expect(body(toggles[0]!)?.textContent).not.toContain("Copy message");
    expect(container.textContent).toContain("3 more updates omitted");
  });

  it("keeps registry navigation disabled without a host callback", () => {
    const [toggle] = renderCard([update()]);
    act(() => toggle!.click());
    expect(
      container.querySelector<HTMLButtonElement>('button[title="bgw-build"]')
        ?.disabled,
    ).toBe(true);
  });

  it("shows the full command when its stored label was cut", () => {
    const command =
      "for pkg in shared server web; do pnpm --filter @assistant/$pkg run build; done";
    const [toggle] = renderCard([
      update({ label: command.slice(0, 40), description: "", command }),
    ]);
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).toContain(command);
  });

  it("does not repeat a short command shown whole in the preview", () => {
    const [toggle] = renderCard([
      update({
        label: "pnpm test",
        description: "",
        command: "pnpm test",
      }),
    ]);
    act(() => toggle!.click());
    expect(container.textContent?.match(/pnpm test/g)?.length).toBe(1);
  });

  it("keeps shell globs and identifiers literal without repeating an unclipped command", () => {
    const label = "rm -f *.log && FOO_BAR=1";
    const [toggle] = renderCard([
      update({ label, description: "", command: label }),
    ]);
    expect(toggle!.querySelector("span.truncate")?.textContent).toBe(label);
    expect(toggle!.getAttribute("title")).toBe(label);
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).not.toContain(label);
    expect(container.textContent!.split(label).length - 1).toBe(1);
  });

  it("reveals a command shortened by the bounded preview even without CSS overflow", () => {
    const command = `pnpm test ${"--project worker ".repeat(30)}`.trim();
    const [toggle] = renderCard([
      update({ label: command, description: "", command }),
    ]);
    expect(container.textContent).not.toContain(command);
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).toContain(command);
  });

  it("reveals a clipped job label even without command or description metadata", () => {
    const label =
      "Watch the deploy until every worker confirms the new release";
    const [toggle] = renderCard([
      update({ label, description: "", command: "" }),
    ]);
    const preview = toggle!.querySelector<HTMLElement>("span.truncate")!;
    Object.defineProperty(preview, "scrollWidth", { value: 600 });
    Object.defineProperty(preview, "clientWidth", { value: 200 });
    act(() => toggle!.click());
    expect(body(toggle!)?.textContent).toContain(label);
  });

  it.each([true, false])(
    "reveals a CSS-clipped label, with description=%s",
    (description) => {
      const label =
        "Watch the deploy log until the systemd unit reports the new release active";
      const command = description ? "journalctl -u pandeck -f" : label;
      const [toggle] = renderCard([
        update({
          label,
          description: description ? label : "",
          command,
        }),
      ]);
      const preview = toggle!.querySelector<HTMLElement>("span.truncate")!;
      Object.defineProperty(preview, "scrollWidth", { value: 600 });
      Object.defineProperty(preview, "clientWidth", { value: 200 });
      act(() => toggle!.click());
      expect(body(toggle!)?.textContent).toContain(label);
      expect(body(toggle!)?.textContent).toContain(command);
      expect(body(toggle!)?.querySelector(".break-words")).not.toBeNull();
    },
  );
});
