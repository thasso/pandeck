// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionStatusCard } from "@assistant/shared";

const api = vi.hoisted(() => ({
  fetchSessionStatus: vi.fn(),
  refreshSessionStatus: vi.fn(),
}));
vi.mock("../../lib/sessionStatusApi.ts", () => api);

const { SessionStatusPanel } = await import("./SessionStatusPanel.tsx");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card: SessionStatusCard = {
  sessionId: "s1",
  markdown: "**Deploy to test.**",
  createdAt: Date.now(),
  sessionUpdatedAt: Date.now(),
  model: {
    provider: "openai-codex",
    modelId: "gpt-6-luna",
    thinkingLevel: "high",
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.fetchSessionStatus.mockReset();
  api.refreshSessionStatus.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SessionStatusPanel sessionId="s1" />);
  });
}

it("joins a refresh another tab started without starting one", async () => {
  api.fetchSessionStatus.mockResolvedValue({ card: null, refreshing: true });
  api.refreshSessionStatus.mockResolvedValue({ card, refreshing: false });

  await render();

  expect(api.refreshSessionStatus).toHaveBeenCalledTimes(1);
  expect(api.refreshSessionStatus).toHaveBeenCalledWith("s1", {
    joinOnly: true,
  });
  expect(container.textContent).toContain("Deploy to test.");
});

it("starts a run only when Refresh is clicked", async () => {
  api.fetchSessionStatus.mockResolvedValue({ card, refreshing: false });
  api.refreshSessionStatus.mockResolvedValue({ card, refreshing: false });

  await render();
  expect(api.refreshSessionStatus).not.toHaveBeenCalled();

  const refresh = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Refresh"),
  )!;
  await act(async () => refresh.click());

  expect(api.refreshSessionStatus).toHaveBeenCalledWith("s1", {
    joinOnly: false,
  });
});

it("keeps the card on screen when a refresh fails", async () => {
  api.fetchSessionStatus.mockResolvedValue({ card, refreshing: false });
  api.refreshSessionStatus.mockRejectedValue(new Error("timed out"));

  await render();
  const refresh = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Refresh"),
  )!;
  await act(async () => refresh.click());

  expect(container.textContent).toContain(
    "Could not write the status: timed out",
  );
  expect(container.textContent).toContain("Deploy to test.");
});
