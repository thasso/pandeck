// @vitest-environment jsdom
/**
 * The Background processes card as a WRITE surface ([Task-486](pa://task/486)):
 * what each control actually sends, and what comes back once the server has
 * normalized it.
 *
 * Static markup assertions cannot answer either question — a field can render
 * its range correctly and still write an out-of-range or NaN value — so every
 * control here is driven through a real change event, and each patch is passed
 * through `normalizeBackgroundWorkSettings`, which is exactly what the server
 * applies on the way in AND on the way out (`server/src/settings.ts`).
 *   pnpm --filter @assistant/web test src/components/backgroundProcessesSettings.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AppSettings, BackgroundWorkSettings } from "@assistant/shared";
import {
  BACKGROUND_WORK_SETTINGS_RANGES,
  DEFAULT_BACKGROUND_WORK_SETTINGS,
  normalizeBackgroundWorkSettings,
} from "@assistant/shared";
import { BackgroundProcessesSettingsSection } from "./BackgroundProcessesSettingsSection.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RANGES = BACKGROUND_WORK_SETTINGS_RANGES;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

/**
 * Mount the card over a stored value, and echo every write back through the
 * server's normalizer — the round trip a real save makes.
 */
function mount(stored: Partial<BackgroundWorkSettings> = {}) {
  const patches: BackgroundWorkSettings[] = [];
  let card = normalizeBackgroundWorkSettings({
    ...DEFAULT_BACKGROUND_WORK_SETTINGS,
    ...stored,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const draw = () =>
    act(() => {
      root!.render(
        <BackgroundProcessesSettingsSection
          settings={{ backgroundWork: card } as AppSettings}
          onUpdate={(patch) => {
            const next = patch.backgroundWork;
            if (!next)
              throw new Error("the card wrote no backgroundWork patch");
            patches.push(next);
            // The server normalizes on the way in and echoes the stored card
            // back; anything the UI sends is therefore seen through this.
            card = normalizeBackgroundWorkSettings(next);
          }}
        />,
      );
    });
  draw();
  const inputs = () => [
    ...container!.querySelectorAll<HTMLInputElement>("input"),
  ];
  return {
    patches,
    settled: () => card,
    checkbox: () => inputs().find((node) => node.type === "checkbox")!,
    numbers: () => inputs().filter((node) => node.type === "number"),
    /** Fire a real change event, then re-render with whatever the echo produced. */
    type(node: HTMLInputElement, value: string) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set!;
        setter.call(node, value);
        node.dispatchEvent(new Event("input", { bubbles: true }));
      });
      draw();
    },
    toggle(node: HTMLInputElement, checked: boolean) {
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "checked",
        )!.set!;
        setter.call(node, checked);
        node.dispatchEvent(new Event("click", { bubbles: true }));
      });
      draw();
    },
  };
}

describe("the Background processes card writes", () => {
  it("sends the master switch both ways and keeps every other value", () => {
    const card = mount();
    card.toggle(card.checkbox(), false);
    expect(card.patches.at(-1)).toEqual({
      ...DEFAULT_BACKGROUND_WORK_SETTINGS,
      enabled: false,
    });
    expect(card.settled().enabled).toBe(false);
    expect(card.checkbox().checked).toBe(false);

    card.toggle(card.checkbox(), true);
    expect(card.settled().enabled).toBe(true);
    expect(card.checkbox().checked).toBe(true);
  });

  it("writes each number field at both ends of its own range", () => {
    const fields = [
      { index: 0, key: "ownerSessionCap", range: RANGES.ownerSessionCap },
      {
        index: 1,
        key: "taskLifetimeMinutes",
        range: RANGES.taskLifetimeMinutes,
      },
      {
        index: 2,
        key: "claudeEmptyHostGraceSeconds",
        range: RANGES.claudeEmptyHostGraceSeconds,
      },
    ] as const;
    for (const field of fields) {
      const card = mount();
      for (const bound of [field.range.min, field.range.max]) {
        card.type(card.numbers()[field.index]!, String(bound));
        expect(card.patches.at(-1)?.[field.key]).toBe(bound);
        // And the SERVER's normalizer agrees it is storable as sent.
        expect(card.settled()[field.key]).toBe(bound);
        expect(card.numbers()[field.index]!.value).toBe(String(bound));
      }
      act(() => root?.unmount());
      container?.remove();
      root = null;
      container = null;
    }
  });

  it("never sends a value outside its range, even when one is typed", () => {
    const card = mount();
    const [cap, lifetime, grace] = card.numbers();
    card.type(cap!, "999");
    expect(card.patches.at(-1)?.ownerSessionCap).toBe(
      RANGES.ownerSessionCap.max,
    );
    card.type(cap!, "0");
    expect(card.patches.at(-1)?.ownerSessionCap).toBe(
      RANGES.ownerSessionCap.min,
    );
    card.type(lifetime!, "1");
    expect(card.patches.at(-1)?.taskLifetimeMinutes).toBe(
      RANGES.taskLifetimeMinutes.min,
    );
    card.type(grace!, "100000");
    expect(card.patches.at(-1)?.claudeEmptyHostGraceSeconds).toBe(
      RANGES.claudeEmptyHostGraceSeconds.max,
    );
    // Every patch this card ever sent survives the server normalizer unchanged.
    for (const patch of card.patches)
      expect(normalizeBackgroundWorkSettings(patch)).toEqual(patch);
  });

  it("writes the shipped default rather than NaN when a field is emptied", () => {
    const card = mount({ taskLifetimeMinutes: 120 });
    card.type(card.numbers()[1]!, "");
    expect(card.patches.at(-1)?.taskLifetimeMinutes).toBe(
      DEFAULT_BACKGROUND_WORK_SETTINGS.taskLifetimeMinutes,
    );
    expect(
      Number.isNaN(card.patches.at(-1)?.taskLifetimeMinutes ?? Number.NaN),
    ).toBe(false);
  });

  it("renders a hand-edited out-of-range stored file at its clamped value", () => {
    const card = mount({
      ownerSessionCap: 9_999,
      taskLifetimeMinutes: 0,
      claudeEmptyHostGraceSeconds: -5,
    });
    expect(card.numbers().map((node) => node.value)).toEqual([
      String(RANGES.ownerSessionCap.max),
      String(RANGES.taskLifetimeMinutes.min),
      String(RANGES.claudeEmptyHostGraceSeconds.min),
    ]);
  });
});
