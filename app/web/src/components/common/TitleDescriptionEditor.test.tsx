// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TitleDescriptionEditor } from "./TitleDescriptionEditor.tsx";
import { idle, loading, ready, type LoadState } from "../../lib/loadState.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
it("retains the title/description draft on unknown and closes after a successful retry", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onClose = vi.fn();
  const onSave = vi.fn();
  const render = async (state: LoadState<true>) =>
    act(async () =>
      root.render(
        <TitleDescriptionEditor
          title="Original"
          description="Body"
          titleLabel="Title"
          descriptionLabel="Description"
          onSave={onSave}
          onClose={onClose}
          submitState={state}
        />,
      ),
    );
  try {
    await render(idle());
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Attempted");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    )!;
    await act(async () => save.click());
    await render(loading());
    await render(idle());
    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("Attempted");
    expect(input.readOnly).toBe(false);
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledTimes(2);
    await render(loading());
    await render(ready(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
