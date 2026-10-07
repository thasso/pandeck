// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfirmDialog, DialogProvider, useDialogs } from "./dialogs.tsx";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The confirmation surface that replaced `window.confirm`/`prompt` (see
 * `../../nativeDialogAudit.test.ts`). What matters here is the contract every
 * call site now depends on: an answer arrives exactly once, cancelling in any
 * of its three ways answers false, and the keys the dialog owns never reach the
 * app-wide shortcut listener behind it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function mount(element: React.ReactElement): void {
  // A test that mounts twice leaves nothing of the first behind: these helpers
  // query the whole document, so a leaked container would answer for it.
  act(() => root?.unmount());
  container?.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(found, `no “${label}” button`).toBeTruthy();
  return found as HTMLButtonElement;
}

/** A host that exposes the promise the app's handler would have awaited. */
function askOnce(
  ask: (dialogs: ReturnType<typeof useDialogs>) => Promise<unknown>,
): { answered: unknown[] } {
  const answered: unknown[] = [];
  function Harness() {
    const dialogs = useDialogs();
    const [started, setStarted] = useState(false);
    if (!started) {
      setStarted(true);
      void ask(dialogs).then((value) => answered.push(value));
    }
    return <button type="button">behind the dialog</button>;
  }
  mount(
    <DialogProvider>
      <Harness />
    </DialogProvider>,
  );
  return { answered };
}

/** A mounted host whose `dialogs` the test drives itself, ask by ask. */
function host(): ReturnType<typeof useDialogs> {
  let captured: ReturnType<typeof useDialogs> | null = null;
  function Harness() {
    captured = useDialogs();
    return <button type="button">behind the dialog</button>;
  }
  mount(
    <DialogProvider>
      <Harness />
    </DialogProvider>,
  );
  expect(captured, "harness never rendered").not.toBeNull();
  return captured!;
}

async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function field(): HTMLInputElement {
  const input = document.querySelector("input[type=text]");
  expect(input, "no text field").not.toBeNull();
  return input as HTMLInputElement;
}

function type(text: string): void {
  const input = field();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(): void {
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("resolves true only when the user confirms", async () => {
  const asked = askOnce((dialogs) =>
    dialogs.confirm({
      title: "Delete Task “T”?",
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    }),
  );
  expect(document.body.textContent).toContain("Delete Task “T”?");
  expect(document.body.textContent).toContain("This cannot be undone.");

  act(() => button("Delete").click());
  await settled();
  expect(asked.answered).toEqual([true]);
  // The surface closes with the answer, rather than waiting for the caller.
  expect(document.body.textContent).not.toContain("Delete Task “T”?");
});

it("answers false for cancel, Escape and the backdrop alike", async () => {
  for (const dismiss of [
    () => button("Cancel").click(),
    () =>
      document
        .querySelector("form")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
    () =>
      (
        document.querySelector('[role="dialog"]')!.parentElement as HTMLElement
      ).click(),
  ]) {
    const asked = askOnce((dialogs) => dialogs.confirm({ title: "Sure?" }));
    act(() => {
      dismiss();
    });
    await settled();
    expect(asked.answered).toEqual([false]);
  }
});

it("returns the trimmed prompt value, and null for an empty answer", async () => {
  const asked = askOnce((dialogs) =>
    dialogs.promptText({ title: "Rename session", defaultValue: "Old name" }),
  );
  expect(field().value).toBe("Old name");
  // The field is focused and selected, so typing replaces the current name.
  expect(document.activeElement).toBe(field());

  type("  New name  ");
  submit();
  await settled();
  expect(asked.answered).toEqual(["New name"]);

  const blank = askOnce((dialogs) =>
    dialogs.promptText({ title: "Rename session", defaultValue: "Old name" }),
  );
  type("   ");
  submit();
  await settled();
  expect(blank.answered).toEqual([null]);
});

it("keeps its keys away from the app-wide shortcut listener", () => {
  const onWindowKey = vi.fn();
  window.addEventListener("keydown", onWindowKey);
  try {
    askOnce((dialogs) => dialogs.confirm({ title: "Sure?" }));
    act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
        );
    });
    // The Backlog's Delete shortcut lives on `window`; a key pressed inside the
    // dialog must not also delete what is behind it.
    expect(onWindowKey).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", onWindowKey);
  }
});

it("settles every ask, including two raised in the same tick", async () => {
  const dialogs = host();
  const answered: unknown[] = [];
  // Neither ask has rendered when the other is made, which is exactly the case
  // where a ref synchronized by rendering loses the first promise for good.
  act(() => {
    void dialogs
      .confirm({ title: "First?" })
      .then((value) => answered.push(["first", value]));
    void dialogs
      .confirm({ title: "Second?" })
      .then((value) => answered.push(["second", value]));
  });
  await settled();

  // The question nobody saw is answered no, and the one on screen is the last.
  expect(answered).toEqual([["first", false]]);
  expect(document.body.textContent).toContain("Second?");
  expect(document.body.textContent).not.toContain("First?");

  act(() => button("Confirm").click());
  await settled();
  expect(answered).toEqual([
    ["first", false],
    ["second", true],
  ]);
});

it("gives a replacing prompt its own field, not the previous answer", async () => {
  const dialogs = host();
  const answered: unknown[] = [];
  act(() => {
    void dialogs
      .promptText({ title: "Rename session", defaultValue: "Old name" })
      .then((value) => answered.push(value));
  });
  type("half-typed answer");

  // A second ask while the first is open is a different question: it must not
  // inherit the abandoned field value, and it must take focus for itself.
  act(() => {
    void dialogs
      .promptText({ title: "Rename profile", defaultValue: "Main account" })
      .then((value) => answered.push(value));
  });
  await settled();
  expect(answered).toEqual([null]);
  expect(field().value).toBe("Main account");
  expect(document.activeElement).toBe(field());

  submit();
  await settled();
  expect(answered).toEqual([null, "Main account"]);
});

it("stays mounted for the whole app, so no surface can ask into the void", () => {
  // The one mount point. Without it every `dialogs.confirm(...)` would throw at
  // the click, which is the silent dead button this module replaced.
  const main = readFileSync(join(HERE, "../../main.tsx"), "utf8");
  expect(main).toMatch(/<DialogProvider>\s*<App \/>\s*<\/DialogProvider>/);
});

it("busies only the confirming control while the caller's write settles", () => {
  mount(
    <ConfirmDialog
      title="Clean worktree"
      confirmLabel="Clean"
      danger
      busy
      error="git clean refused"
      onConfirm={() => undefined}
      onCancel={() => undefined}
    />,
  );
  const confirm = button("Clean");
  expect(confirm.getAttribute("aria-busy")).toBe("true");
  expect(confirm.disabled).toBe(true);
  // Cancel stays out of reach while the write runs, and the failure is shown
  // without closing the dialog.
  expect(button("Cancel").disabled).toBe(true);
  expect(document.body.textContent).toContain("git clean refused");
});
