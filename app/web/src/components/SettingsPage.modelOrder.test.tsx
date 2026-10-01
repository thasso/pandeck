// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  modelKey,
  type AppSettings,
  type ModelOption,
} from "@assistant/shared";
import { ModelsSection } from "./SettingsPage.tsx";

/**
 * The drag gesture itself is covered by `hooks/usePointerReorder.test.tsx`.
 * This is the join between it and the settings surface: the working copy
 * `ModelsSection` keeps while a finger is down, and the resync effect that
 * replaces that copy whenever the PERSISTED order changes. The two meet when a
 * settings echo lands mid-drag, which no test of either half alone can reach.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const models: ModelOption[] = ["a", "b", "c"].map((id) => ({
  provider: "p",
  id,
  name: `Model ${id.toUpperCase()}`,
  reasoning: false,
  contextWindow: 1000,
}));

const settingsWith = (order: string[]): AppSettings =>
  ({ models: { order, hidden: [] } }) as unknown as AppSettings;

const ROW_PITCH = 30;

/** The boxes a browser would have measured; jsdom lays nothing out. */
function stubRows(list: Element) {
  for (const row of Array.from(list.children))
    row.getBoundingClientRect = function (this: Element) {
      const index = Array.from(this.parentElement!.children).indexOf(this);
      return {
        top: index * ROW_PITCH,
        bottom: index * ROW_PITCH + 20,
      } as DOMRect;
    };
}

function pointer(type: string, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    isPrimary: true,
    clientX: 0,
    clientY: y,
  });
  return event;
}

function render(onUpdate: (patch: Partial<AppSettings>) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const show = (settings: AppSettings) =>
    act(() => {
      root!.render(
        <ModelsSection
          models={models}
          settings={settings}
          onUpdate={onUpdate}
          onRefresh={() => {}}
          refreshing={false}
        />,
      );
    });
  show(settingsWith(models.map(modelKey)));
  const list = container.querySelector("ul")!;
  stubRows(list);
  return {
    show,
    list,
    order: () =>
      Array.from(list.querySelectorAll("li button[aria-label^='Reorder']")).map(
        (grip) => grip.getAttribute("aria-label")!.slice(8, 15).trim(),
      ),
    grip: (index: number) =>
      list.querySelectorAll<HTMLButtonElement>("button[aria-label^='Reorder']")[
        index
      ]!,
  };
}

describe("model order settings", () => {
  it("saves the dragged arrangement as the visible order", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(pointer("pointerdown", 5));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", 70));
    });
    act(() => {
      window.dispatchEvent(pointer("pointerup", 70));
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0]).toEqual({
      models: { order: ["p:b", "p:c", "p:a"], hidden: [] },
    });
  });

  /**
   * The persisted order changing mid-drag (an echo from another surface, a
   * refresh) resyncs the working copy. That list is the authoritative one, so
   * the release must not save the arrangement the finger was building over it.
   */
  it("drops a drag that a settings change interrupts", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(pointer("pointerdown", 5));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", 70));
    });
    expect(view.order()).toEqual(["Model B", "Model C", "Model A"]);

    // The same models, ordered by someone else.
    view.show(settingsWith(["p:c", "p:b", "p:a"]));
    stubRows(view.list);
    expect(view.order()).toEqual(["Model C", "Model B", "Model A"]);

    act(() => {
      window.dispatchEvent(pointer("pointermove", 5));
      window.dispatchEvent(pointer("pointerup", 5));
    });
    expect(view.order()).toEqual(["Model C", "Model B", "Model A"]);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("announces where a keyboard move put the model", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onUpdate.mock.calls[0]![0]).toEqual({
      models: { order: ["p:b", "p:a", "p:c"], hidden: [] },
    });
    expect(container!.querySelector("[aria-live]")!.textContent).toBe(
      "Model A moved to position 2 of 3",
    );
  });
});
