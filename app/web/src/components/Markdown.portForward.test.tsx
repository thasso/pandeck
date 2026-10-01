// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoopbackLink } from "../lib/portForwardLinks.ts";

/**
 * Phase 3 of `docs/port-forwarding.md`: a plain click on a `localhost:PORT`
 * link in a conversation, read in the macOS app served from the tailnet, is
 * forwarded rather than opened as written. The interception has to be exactly
 * that narrow — every other click, client and link keeps the anchor's own
 * behaviour, and the anchor itself is unchanged so a modified click, the
 * context menu and a drag still see the authored URL.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const openForwardedLink = vi.fn<(link: LoopbackLink) => Promise<void>>();
vi.mock("../lib/portForwards.ts", () => ({
  openForwardedLink: (link: LoopbackLink) => openForwardedLink(link),
}));

const { Markdown } = await import("./Markdown.tsx");

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  openForwardedLink.mockReset();
  openForwardedLink.mockResolvedValue(undefined);
  document.documentElement.setAttribute("data-native-shell", "macos");
  vi.stubEnv("VITE_SERVER_ORIGIN", "app.acme.test");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.documentElement.removeAttribute("data-native-shell");
  vi.unstubAllEnvs();
});

function render(text: string): HTMLAnchorElement {
  act(() => root!.render(<Markdown text={text} />));
  return container!.querySelector("a")!;
}

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

const LINK = "[dev server](http://127.0.0.1:5173/app?tab=1#top)";

it("forwards a plain click and keeps the authored anchor", () => {
  const anchor = render(LINK);
  expect(anchor.getAttribute("href")).toBe(
    "http://127.0.0.1:5173/app?tab=1#top",
  );
  expect(anchor.getAttribute("target")).toBe("_blank");

  const event = click(anchor);
  expect(event.defaultPrevented).toBe(true);
  expect(openForwardedLink).toHaveBeenCalledWith({
    port: 5173,
    localUrl: "http://localhost:5173/app?tab=1#top",
  });
});

it("leaves a modified click to the browser", () => {
  const anchor = render(LINK);
  for (const init of [
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const event = click(anchor, init);
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
  }
  expect(openForwardedLink).not.toHaveBeenCalled();
});

it("does nothing outside the macOS shell", () => {
  document.documentElement.removeAttribute("data-native-shell");
  expect(click(render(LINK)).defaultPrevented).toBe(false);
  document.documentElement.setAttribute("data-native-shell", "ios");
  expect(click(render(LINK)).defaultPrevented).toBe(false);
  expect(openForwardedLink).not.toHaveBeenCalled();
});

it("does nothing when the app itself is served from loopback", () => {
  vi.stubEnv("VITE_SERVER_ORIGIN", "localhost:8787");
  expect(click(render(LINK)).defaultPrevented).toBe(false);
  expect(openForwardedLink).not.toHaveBeenCalled();
});

it("does nothing for links that are not explicit loopback URLs with a port", () => {
  for (const href of [
    "https://app.acme.test/sessions",
    "http://localhost/",
    "http://localhost:80/",
    "http://localhost:1023/",
    "http://localhost.example:5173/",
  ]) {
    const event = click(render(`[x](${href})`));
    expect(event.defaultPrevented, href).toBe(false);
  }
  expect(openForwardedLink).not.toHaveBeenCalled();
});
