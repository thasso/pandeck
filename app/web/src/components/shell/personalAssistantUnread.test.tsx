// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RightPanelTabs } from "./RightPanelTabs.tsx";
import { PrimaryNav } from "./PrimaryNav.tsx";
import { OverflowList } from "./SectionOverflow.tsx";
import { PRIMARY_NAV_SLOTS } from "../primaryNavSections.tsx";
import { UnreadIcon } from "../UnreadDot.tsx";
import { useSessionRouting } from "../../hooks/useSessionRouting.ts";

const lifecycle = vi.hoisted(() => ({ opens: 0, closes: 0 }));
vi.mock("./PersonalAssistantPanel.tsx", () => ({
  PersonalAssistantPanel: () => {
    useEffect(() => {
      lifecycle.opens++;
      return () => {
        lifecycle.closes++;
      };
    }, []);
    return <div>Assistant transcript</div>;
  },
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  lifecycle.opens = 0;
  lifecycle.closes = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("reopens the PA reader after returning from a pure UI route", async () => {
  window.history.replaceState(null, "", "/assistant");
  const open = vi.fn();
  let routing!: ReturnType<typeof useSessionRouting>;
  function RoutedAssistant() {
    routing = useSessionRouting({
      connected: true,
      hydrated: true,
      sessions: [],
      currentId: "pa",
      hasMessages: true,
      loadSession: () => {},
      openPermanentAssistant: open,
    });
    return null;
  }
  await act(async () => root.render(<RoutedAssistant />));
  expect(open).toHaveBeenCalledTimes(1);
  await act(async () => routing.navigate("/settings"));
  await act(async () => routing.navigate("/assistant"));
  expect(open).toHaveBeenCalledTimes(2);
});

it("shows a width-neutral dot in the assistant nav slot and overflow list", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
  } as DOMRect);
  const assistant = {
    id: "assistant",
    label: PRIMARY_NAV_SLOTS.assistant.label,
    icon: <UnreadIcon icon={PRIMARY_NAV_SLOTS.assistant.icon} unread />,
  };
  await act(async () =>
    root.render(
      <PrimaryNav
        sections={[assistant]}
        activeId="sessions"
        onSelect={() => {}}
        mobile={false}
      />,
    ),
  );
  const slot = container.querySelector("button")!;
  const dot = slot.querySelector('[title="Unread"]')!;
  expect(dot.classList.contains("absolute")).toBe(true);
  expect(dot.parentElement?.classList.contains("relative")).toBe(true);
  await act(async () =>
    root.render(
      <OverflowList
        items={[assistant]}
        activeId="sessions"
        onSelect={() => {}}
        close={() => {}}
      />,
    ),
  );
  expect(container.querySelector('[title="Unread"]')).not.toBeNull();
});

it("hides the PA tab dot while visible and releases the reading connection while hidden", async () => {
  window.sessionStorage.setItem(
    "assistant.right-panel-tabs.v1",
    JSON.stringify({
      openTabs: ["inspector", "personal-assistant"],
      activeTab: "personal-assistant",
    }),
  );
  const render = (visible: boolean) =>
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector</div>}
        worktree={null}
        status={null}
        visible={visible}
        assistantUnread
      />,
    );
  await act(async () => render(false));
  expect(container.querySelector('[title="Unread"]')).not.toBeNull();
  expect(lifecycle.opens).toBe(0);
  await act(async () => render(true));
  expect(container.querySelector('[title="Unread"]')).toBeNull();
  expect(lifecycle.opens).toBe(1);
  await act(async () => render(false));
  expect(lifecycle.closes).toBe(1);
  expect(container.querySelector('[title="Unread"]')).not.toBeNull();
  await act(async () => render(true));
  const inspectorTab =
    container.querySelector<HTMLButtonElement>(
      '[role="tab"][data-value="inspector"]',
    ) ??
    [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (element) => element.textContent === "Inspector",
    );
  await act(async () => inspectorTab!.click());
  expect(lifecycle.closes).toBe(2);
  expect(container.querySelector('[title="Unread"]')).not.toBeNull();
});
