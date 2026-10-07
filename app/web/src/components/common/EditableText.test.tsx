// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditableText } from "./EditableText.tsx";
import {
  failed,
  idle,
  loading,
  ready,
  type LoadState,
} from "../../lib/loadState.ts";

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

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Host({
  value = "Original",
  multiline = false,
  allowEmpty = false,
  submitState,
  onSubmit,
}: {
  value?: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  submitState?: LoadState<true>;
  onSubmit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      <EditableText
        value={value}
        onSubmit={onSubmit}
        editing={editing}
        onEditingChange={setEditing}
        multiline={multiline}
        allowEmpty={allowEmpty}
        submitState={submitState}
        label="Field"
      >
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      </EditableText>
      <button type="button">Elsewhere</button>
    </>
  );
}

async function render(props: Parameters<typeof Host>[0]) {
  await act(async () => root.render(<Host {...props} />));
}

/** The host's save runs and succeeds. */
async function settle(props: Parameters<typeof Host>[0]) {
  await render({ ...props, submitState: loading() });
  await render({ ...props, submitState: ready(true) });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === name,
  );
  if (!found) throw new Error(`no button ${name}`);
  return found;
}

function field(): HTMLInputElement | HTMLTextAreaElement | null {
  return container.querySelector('[aria-label="Field"]');
}

async function open() {
  await act(async () => button("Edit").click());
  return field()!;
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(el: Element, init: KeyboardEventInit) {
  await act(async () => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

describe("EditableText single-line", () => {
  it("focuses on open, saves on Enter and on blur, cancels on Escape", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    let input = await open();
    expect(input.tagName).toBe("INPUT");
    expect(document.activeElement).toBe(input);

    await type(input, "  Renamed  ");
    await key(input, { key: "Escape" });
    expect(field()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();

    input = await open();
    expect(input.value).toBe("Original");
    await type(input, "  Renamed  ");
    await key(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenLastCalledWith("Renamed");
    await settle({ onSubmit });
    expect(field()).toBeNull();

    input = await open();
    await type(input, "Blurred");
    await act(async () => button("Elsewhere").focus());
    expect(onSubmit).toHaveBeenLastCalledWith("Blurred");
    await settle({ onSubmit });
    expect(field()).toBeNull();
  });

  it("treats unchanged and disallowed-empty edits as no-ops", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    let input = await open();
    await type(input, " Original ");
    await key(input, { key: "Enter" });
    input = await open();
    await type(input, "   ");
    await key(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toBeNull();
  });

  it("does not commit when Cancel is pressed", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    const input = await open();
    await type(input, "Draft");
    await act(async () => {
      button("Cancel").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
      button("Cancel").focus();
      button("Cancel").click();
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toBeNull();
  });
});

describe("EditableText multiline", () => {
  it("saves on Cmd/Ctrl+Enter only, never on blur, and trims trailing space", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit, multiline: true, allowEmpty: true });
    const textarea = await open();
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(document.activeElement).toBe(textarea);

    await type(textarea, "Line one\nLine two\n\n");
    await key(textarea, { key: "Enter" });
    await act(async () => button("Elsewhere").focus());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).not.toBeNull();

    await key(textarea, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledWith("Line one\nLine two");
  });

  it("commits an empty value when allowed", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit, multiline: true, allowEmpty: true });
    const textarea = await open();
    await type(textarea, "");
    await key(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("");
  });
});

describe("EditableText save lifecycle", () => {
  it("stays open while pending, keeps the draft on failure, closes on success", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit, submitState: idle() });
    const input = await open();
    await type(input, "Renamed");
    await key(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(field()).not.toBeNull();

    await render({ onSubmit, submitState: loading() });
    expect(button("Save").getAttribute("aria-busy")).toBe("true");
    expect(button("Save").disabled).toBe(true);
    await key(input, { key: "Enter" });
    await act(async () => button("Save").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await render({ onSubmit, submitState: failed("Refused") });
    expect(field()?.value).toBe("Renamed");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Refused",
    );
    await act(async () => button("Retry").click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith("Renamed");

    await render({ onSubmit, submitState: loading() });
    expect(field()).not.toBeNull();
    await render({ onSubmit, submitState: ready(true) });
    expect(field()).toBeNull();
  });

  it("does not close on a stale success, nor show a stale error on open", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit, submitState: failed("Old failure") });
    const input = await open();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await render({ onSubmit, submitState: ready(true) });
    await type(input, "Renamed");
    await key(input, { key: "Enter" });
    await render({ onSubmit, submitState: ready(true) });
    expect(field()).not.toBeNull();
  });

  // Hosts patch their lists optimistically, so the live value reads as the
  // draft while the save runs and after it is refused.
  it("retries a refused save even while the value is still optimistic", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit, submitState: ready(true) });
    const input = await open();
    await type(input, "Attempt");
    await act(async () => button("Save").click());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await render({ onSubmit, value: "Attempt", submitState: loading() });
    expect(field()).not.toBeNull();
    expect(field()?.value).toBe("Attempt");
    expect(button("Save").getAttribute("aria-busy")).toBe("true");

    await render({
      onSubmit,
      value: "Attempt",
      submitState: failed("Refused"),
    });
    expect(container.textContent).toContain("Refused");
    await act(async () => button("Retry").click());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith("Attempt");
    expect(field()).not.toBeNull();

    await settle({ onSubmit, value: "Attempt" });
    expect(field()).toBeNull();
  });

  it("measures a no-op against the value it opened on, not a later one", async () => {
    const onSubmit = vi.fn();
    await render({ onSubmit });
    const input = await open();
    await type(input, "Elsewhere renamed");
    // Another writer lands the same text while this editor is open.
    await render({ onSubmit, value: "Elsewhere renamed" });
    await key(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("Elsewhere renamed");
  });

  it("holds a multiline draft read-only while its save runs", async () => {
    const onSubmit = vi.fn();
    const props = { onSubmit, multiline: true, allowEmpty: true };
    await render(props);
    const textarea = await open();
    await type(textarea, "Draft A");
    await key(textarea, { key: "Enter", ctrlKey: true });
    await render({ ...props, value: "Draft A", submitState: loading() });
    expect(textarea.readOnly).toBe(true);
    expect(button("Save").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);

    await render({ ...props, value: "Draft A", submitState: failed("No") });
    expect(textarea.readOnly).toBe(false);
    expect(textarea.value).toBe("Draft A");
  });
});
