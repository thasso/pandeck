// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PageHeader } from "../PageHeader.tsx";
import { Inspector, InspectorChromeProvider } from "./Inspector.tsx";
import { RoutePrimaryActionProvider } from "./RoutePrimaryAction.tsx";
import { AppShell, type ShellPanel } from "./AppShell.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function closedInspector(action: {
  key: string;
  label: string;
  onRun: () => void;
}): ShellPanel {
  return {
    open: false,
    width: 320,
    minWidth: 240,
    onResize: () => {},
    label: "inspector",
    keepMountedWhenClosed: true,
    content: (
      <InspectorChromeProvider header={false} desktopTabs>
        <Inspector relations={[]} actions={[action]} />
      </InspectorChromeProvider>
    ),
  };
}

async function renderWithRight(right: ShellPanel) {
  await act(async () => {
    root.render(
      <RoutePrimaryActionProvider action={null}>
        <AppShell mobile={false} right={right}>
          <PageHeader title="Object" />
        </AppShell>
      </RoutePrimaryActionProvider>,
    );
  });
}

it("keeps the page-header overflow actions available with a closed right panel", async () => {
  await renderWithRight(
    closedInspector({ key: "archive", label: "Archive", onRun: () => {} }),
  );

  expect(
    container.querySelector('button[title="Inspector actions"]'),
  ).toBeTruthy();
});

it("runs the current object's action when its menu shape matches the previous object", async () => {
  const runs: string[] = [];
  await renderWithRight(
    closedInspector({
      key: "run-workflow",
      label: "Run workflow…",
      onRun: () => runs.push("task-614"),
    }),
  );
  await renderWithRight(
    closedInspector({
      key: "run-workflow",
      label: "Run workflow…",
      onRun: () => runs.push("task-615"),
    }),
  );

  act(() => {
    container
      .querySelector<HTMLButtonElement>('button[title="Inspector actions"]')
      ?.click();
  });
  act(() => {
    [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("Run workflow"))
      ?.click();
  });

  expect(runs).toEqual(["task-615"]);
});
