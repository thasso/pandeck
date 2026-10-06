// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RightPanelTabs } from "./RightPanelTabs.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.getAttribute("aria-label") === label,
  )!;
}

it("reports which panel is the visible one", async () => {
  const active: (string | null)[] = [];
  await act(async () => {
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
        onActivePanelChange={(panel) => active.push(panel)}
      />,
    );
  });
  expect(active.at(-1)).toBe("inspector");

  // Closing the last tab leaves the panel home up: nothing is visible there.
  await act(async () => button("Close Inspector").click());
  expect(active.at(-1)).toBeNull();
});

it("uses the available-panel home after the final tab closes", async () => {
  await act(async () => {
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
      />,
    );
  });
  expect(container.textContent).toContain("Inspector body");

  await act(async () => button("Close Inspector").click());
  expect(container.textContent).toContain("Open a panel");
  expect(container.textContent).toContain("Inspector");
  expect(container.textContent).toContain("Personal Assistant");
});

it("keeps an open Inspector mounted while Personal Assistant is selected", async () => {
  await act(async () => {
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
      />,
    );
  });
  await act(async () => button("Open a right panel").click());
  const personalAssistant = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.textContent?.trim() === "Personal Assistant")!;
  await act(async () => personalAssistant.click());

  expect(container.textContent).toContain("Inspector body");
  expect(container.textContent).toContain("Personal Assistant");
});

it("opens Personal Assistant from the panel home", async () => {
  await act(async () => {
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
      />,
    );
  });
  await act(async () => button("Close Inspector").click());
  const personalAssistant = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.textContent?.trim() === "Personal Assistant")!;
  await act(async () => personalAssistant.click());

  expect(container.textContent).toContain("Personal Assistant");
  expect(button("Close Personal Assistant")).toBeTruthy();
});

it("opens the Knowledge panel on an outside request and keeps it mounted", async () => {
  const render = (nonce: number | null) =>
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
        openRequest={nonce === null ? undefined : { panel: "knowledge", nonce }}
      />,
    );
  await act(async () => render(null));
  expect(container.textContent).not.toContain("Knowledge body");

  await act(async () => render(1));
  expect(container.textContent).toContain("Knowledge body");
  expect(button("Close Knowledge")).toBeTruthy();

  // Selecting another tab leaves the panel mounted; a fresh request brings it
  // back to the front rather than needing its tab reopened.
  const inspectorTab = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.textContent?.trim() === "Inspector")!;
  await act(async () => inspectorTab.click());
  expect(container.querySelector("[inert]")).toBeTruthy();

  await act(async () => render(2));
  const knowledgePane = [...container.querySelectorAll("div")].find((element) =>
    element.textContent?.includes("Knowledge body"),
  )!;
  expect(knowledgePane.closest("[inert]")).toBeNull();
});

it("builds a tab's surface when it is first seen, not when it is merely open", async () => {
  // What a reload restores: the Worktree tab active, with the right panel shut.
  // Nobody has looked at it, and its body fetches and subscribes on mount.
  window.sessionStorage.setItem(
    "assistant.right-panel-tabs.v1",
    JSON.stringify({
      openTabs: ["inspector", "worktree"],
      activeTab: "worktree",
    }),
  );
  const render = (visible: boolean) =>
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
        visible={visible}
      />,
    );

  await act(async () => render(false));
  expect(container.textContent).not.toContain("Worktree body");
  // The Inspector is the exception: it publishes the page header's overflow
  // actions, which is why the host stays mounted while the panel is shut.
  expect(container.textContent).toContain("Inspector body");

  await act(async () => render(true));
  expect(container.textContent).toContain("Worktree body");

  // Seen once, it stays: shutting the panel again must not tear its data down.
  await act(async () => render(false));
  expect(container.textContent).toContain("Worktree body");
});

it("leaves an open tab behind another one unbuilt until it is selected", async () => {
  window.sessionStorage.setItem(
    "assistant.right-panel-tabs.v1",
    JSON.stringify({
      openTabs: ["inspector", "worktree"],
      activeTab: "inspector",
    }),
  );
  await act(async () => {
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        knowledge={<div>Knowledge body</div>}
        worktree={<div>Worktree body</div>}
      />,
    );
  });
  expect(container.textContent).not.toContain("Worktree body");

  const worktreeTab = [
    ...container.querySelectorAll<HTMLButtonElement>("button"),
  ].find((element) => element.textContent?.trim() === "Worktree")!;
  await act(async () => worktreeTab.click());
  expect(container.textContent).toContain("Worktree body");
});

it("offers no Knowledge tab while the Knowledge Base is off, and keeps its place", async () => {
  const render = (knowledge: boolean) =>
    root.render(
      <RightPanelTabs
        inspector={<div>Inspector body</div>}
        {...(knowledge ? { knowledge: <div>Knowledge body</div> } : {})}
        worktree={<div>Worktree body</div>}
        openRequest={{ panel: "knowledge", nonce: 1 }}
      />,
    );
  await act(async () => render(true));
  expect(button("Close Knowledge")).toBeTruthy();

  await act(async () => render(false));
  expect(button("Close Knowledge")).toBeUndefined();
  expect(container.textContent).not.toContain("Knowledge body");
  await act(async () => button("Open a right panel").click());
  expect(container.textContent).not.toContain("Knowledge");

  // Turned back on, the tab is where it was.
  await act(async () => render(true));
  expect(button("Close Knowledge")).toBeTruthy();
});
