import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach } from "vitest";

/**
 * Mounting a component into jsdom, the setup most component tests share.
 * Importing this module opts the file into React's `act()` environment, and
 * every root it mounts is unmounted and its container removed after each test,
 * so a test only says what it renders.
 *
 * That cleanup is a file-level `afterEach`, so it runs AFTER a describe's own.
 * A teardown that must follow the unmount (clearing storage an unmount writes,
 * removing nodes React portaled out) unmounts first itself; the second
 * unmount is a no-op.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export interface Mounted {
  container: HTMLDivElement;
  root: Root;
  /** Render, or re-render into the same root, inside `act()`. */
  render(ui: ReactNode): void;
}

const mounted = new Set<Mounted>();

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.clear();
});

/** A fresh container attached to the document, rendering `ui` when given. */
export function mount(ui?: ReactNode): Mounted {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view: Mounted = {
    container,
    root,
    render: (next) => act(() => root.render(next)),
  };
  mounted.add(view);
  if (ui !== undefined) view.render(ui);
  return view;
}
