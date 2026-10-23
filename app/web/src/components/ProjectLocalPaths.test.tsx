// @vitest-environment jsdom
import { act } from "react";
import type { ProjectLocalPath } from "@assistant/shared";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectLocalPathsSection } from "./ProjectLocalPaths.tsx";
import {
  failed,
  idle,
  loading,
  ready,
  type LoadState,
} from "../lib/loadState.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let onSave: ReturnType<typeof vi.fn<(localPaths: ProjectLocalPath[]) => void>>;
const project = { id: "a", name: "Alpha", key: "AA" };
beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onSave = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(
  mutationState?: LoadState<true>,
  id = "a",
  localPaths: ProjectLocalPath[] = [],
) {
  await act(async () =>
    root.render(
      <ProjectLocalPathsSection
        project={{ ...project, id, localPaths }}
        onSave={onSave}
        mutationState={mutationState}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (el) =>
      el.getAttribute("aria-label") === label ||
      el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
const field = () =>
  container.querySelector<HTMLInputElement>('[aria-label="New local path"]');
async function key(key: string) {
  await act(async () =>
    field()!.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    ),
  );
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(field(), value);
    field()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function begin(state?: LoadState<true>) {
  await render(state);
  await act(async () => button("Local paths").click());
  await act(async () => button("Add a local path").click());
  await type(" /attempted/path ");
  await key("Enter");
  expect(onSave).toHaveBeenCalledWith([
    { path: "/attempted/path", kind: "repo", match: "prefix" },
  ]);
}

describe("local path add outcome policy", () => {
  it.each([false, true])(
    "restores an absent-entry first draft only on fresh unknown release, batched=%s",
    async (batched) => {
      await begin();
      expect(field()).toBeNull();
      if (!batched) await render(loading());
      await render(idle());
      expect(field()?.value).toBe(" /attempted/path ");
      expect(field()?.disabled).toBe(false);
      expect(container.textContent).not.toContain("Retry");
      await key("Enter");
      await render(loading());
      await render(ready(true));
      expect(field()).toBeNull();
    },
  );

  it("keeps first connected success closed and first refusal's inline Retry", async () => {
    await begin();
    await render(loading());
    await render(failed("Refused"));
    expect(field()).toBeNull();
    expect(container.textContent).toContain("Refused");
    await act(async () => button("Retry").click());
    expect(onSave).toHaveBeenCalledTimes(2);
    await render(loading());
    await render(ready(true));
    expect(field()).toBeNull();
    await render(idle());
    expect(field()).toBeNull();
  });

  it.each([false, true])(
    "restores the current refused add after Retry becomes unknown, batched=%s",
    async (batched) => {
      await begin();
      await render(loading());
      await render(failed("Refused"));
      await act(async () => button("Retry").click());
      expect(onSave).toHaveBeenCalledTimes(2);
      if (!batched) await render(loading());
      await render(idle());
      expect(field()?.value).toBe(" /attempted/path ");
      expect(field()?.disabled).toBe(false);
      expect(container.textContent).not.toContain("Retry");
    },
  );

  it("keeps a repeated known Retry refusal retryable, without opening the draft", async () => {
    await begin();
    await render(failed("Refused"));
    await act(async () => button("Retry").click());
    await render(loading());
    await render(failed("Still refused"));
    expect(field()).toBeNull();
    expect(container.textContent).toContain("Still refused");
    await act(async () => button("Retry").click());
    await render(idle());
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(field()?.value).toBe(" /attempted/path ");
  });

  it.each(["cancel", "draft", "project", "submit"])(
    "never restores a retried add over a newer %s interaction",
    async (interaction) => {
      await begin();
      await render(failed("Refused"));
      await act(async () => button("Retry").click());
      if (interaction === "project") {
        await render(undefined, "b");
        await render(idle(), "b");
        expect(field()).toBeNull();
        return;
      }
      await act(async () => button("Add a local path").click());
      if (interaction === "cancel") await key("Escape");
      else {
        await type("/newer/draft");
        if (interaction === "submit") await key("Enter");
      }
      await render(idle());
      expect(field()?.value ?? null).toBe(
        interaction === "cancel" ? null : "/newer/draft",
      );
    },
  );

  it.each(["remove", "kind", "match", "edit"])(
    "does not restore an old add on Retry of a later %s operation",
    async (operation) => {
      await begin();
      const paths: ProjectLocalPath[] = [{ path: "/existing" }];
      await render(failed("Refused"), "a", paths);
      await act(async () => {
        if (operation === "remove") button("Remove local path").click();
        if (operation === "kind") button("repo").click();
        if (operation === "match") button("prefix").click();
        if (operation === "edit") button("/existing").click();
      });
      if (operation === "edit") await act(async () => button("Save").click());
      const latestAttempt = onSave.mock.calls.at(-1)![0];
      await render(loading(), "a", paths);
      await render(failed("Later refused"), "a", paths);
      await act(async () => button("Retry").click());
      expect(onSave).toHaveBeenLastCalledWith(latestAttempt);
      await render(idle(), "a", paths);
      expect(field()).toBeNull();
    },
  );

  it("does not reinterpret an untracked caller or a known success as unknown", async () => {
    await begin();
    await render();
    expect(field()).toBeNull();
    await render(ready(true));
    await render(idle());
    expect(field()).toBeNull();
  });

  it("keeps an initialized draft editable on unknown, and retains it on rejection", async () => {
    await begin(idle());
    expect(field()?.value).toBe(" /attempted/path ");
    await render(loading());
    await render(idle());
    expect(field()?.value).toBe(" /attempted/path ");
    await key("Enter");
    await render(loading());
    await render(failed("Refused"));
    expect(field()?.value).toBe(" /attempted/path ");
  });

  it.each(["cancel", "draft", "project"])(
    "never restores over a newer %s interaction",
    async (interaction) => {
      await begin();
      if (interaction === "project") {
        await render(undefined, "b");
        await render(idle(), "b");
        expect(field()).toBeNull();
        return;
      }
      await act(async () => button("Add a local path").click());
      if (interaction === "cancel") {
        await key("Escape");
      } else await type("/newer/draft");
      await render(idle());
      expect(field()?.value ?? null).toBe(
        interaction === "cancel" ? null : "/newer/draft",
      );
    },
  );
});
