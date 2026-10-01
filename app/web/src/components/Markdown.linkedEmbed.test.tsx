// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown.tsx";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";

/**
 * `[![alt](image)](target)` — an author asking for a picture that links
 * somewhere. Both halves have to survive: the picture renders, and the LINK the
 * author wrote is where a click goes. The one thing it may never become is
 * nested interaction — an anchor inside an anchor, or the standalone embed's
 * Play/Open control inside a link — which is invalid DOM and unusable with a
 * keyboard. Origin rules are unchanged: a foreign image or destination is left
 * exactly as authored and mints nothing.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__ = "tok-1";
  resetHistoryNavForTests();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/sessions/s1");
  initHistoryNav();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  delete (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__;
  vi.unstubAllGlobals();
});

function render(text: string): void {
  act(() => root!.render(<Markdown text={text} />));
}

function anchors(): HTMLAnchorElement[] {
  return [...container!.querySelectorAll("a")];
}

function click(node: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    node.dispatchEvent(event);
  });
  return event;
}

const PLOT = "/api/files/tmp/example/plot.png";

it("keeps the authored internal link around a local image", () => {
  render(`[![the plot](${PLOT})](/api/files/tmp/example/report.md)`);

  expect(anchors()).toHaveLength(1);
  const link = anchors()[0]!;
  expect(link.getAttribute("href")).toBe("/files/tmp/example/report.md");
  const image = link.querySelector("img")!;
  const src = new URL(image.getAttribute("src")!);
  expect(src.pathname).toBe(PLOT);
  expect(src.searchParams.get("token")).toBe("tok-1");
  expect(image.getAttribute("alt")).toBe("the plot");
  // One anchor, no control inside it, and no card chrome.
  expect(link.querySelector("a")).toBeNull();
  expect(container!.querySelector("button")).toBeNull();
  expect(container!.textContent).not.toContain("Preview only");
  expect(container!.textContent).not.toContain("Open in viewer");

  // A plain click opens the document in-app; a modifier click is the browser's.
  expect(click(image).defaultPrevented).toBe(true);
  expect(window.location.pathname).toBe("/files/tmp/example/report.md");
  expect(click(image, { metaKey: true }).defaultPrevented).toBe(false);
});

it("keeps a foreign destination external and a foreign image as authored", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  render(
    "[![a diagram](https://example.com/diagram.png)](https://example.com/post)",
  );

  const link = anchors()[0]!;
  expect(anchors()).toHaveLength(1);
  expect(link.getAttribute("href")).toBe("https://example.com/post");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer noopener");
  const image = link.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("https://example.com/diagram.png");
  expect(image.getAttribute("src")).not.toContain("token");
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("mixes sources without letting either half change the other", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  // A foreign picture linking into the app, and a local picture linking out.
  render(
    [
      "[![remote](https://example.com/shot.png)](/api/files/tmp/example/report.md)",
      `[![local](${PLOT})](https://example.com/post)`,
    ].join("\n\n"),
  );

  const [internal, external] = anchors();
  expect(internal!.getAttribute("href")).toBe("/files/tmp/example/report.md");
  expect(internal!.getAttribute("target")).toBeNull();
  expect(internal!.querySelector("img")?.getAttribute("src")).toBe(
    "https://example.com/shot.png",
  );
  expect(external!.getAttribute("href")).toBe("https://example.com/post");
  expect(external!.getAttribute("target")).toBe("_blank");
  expect(
    new URL(external!.querySelector("img")!.getAttribute("src")!).pathname,
  ).toBe(PLOT);
  // A lookalike foreign path is never treated as a local file.
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("never treats a foreign lookalike destination as an internal document", () => {
  const foreign = "https://evil.example/api/files/tmp/example/report.md";
  render(`[![the plot](${PLOT})](${foreign})`);
  const link = anchors()[0]!;
  expect(link.getAttribute("href")).toBe(foreign);
  expect(link.getAttribute("target")).toBe("_blank");
});

it("names a link whose picture carries no alt text", () => {
  render(`[![](${PLOT})](/api/files/tmp/example/report.md)`);
  expect(anchors()[0]?.getAttribute("aria-label")).toBe("Open report.md");

  act(() => root!.unmount());
  root = createRoot(container!);
  // Alt text is the accessible name when the author wrote one.
  render(`[![the plot](${PLOT})](/api/files/tmp/example/report.md)`);
  expect(anchors()[0]?.getAttribute("aria-label")).toBeNull();
  expect(anchors()[0]?.querySelector("img")?.getAttribute("alt")).toBe(
    "the plot",
  );
});

it("degrades a linked non-image embed to the link's own text", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  render(
    [
      "[![recording](/api/files/tmp/example/clip.mp3)](https://example.com/post)",
      "[![preview](/api/files/tmp/example/page.html)](/api/files/tmp/example/report.md)",
    ].join("\n\n"),
  );

  // No Play button, no sandboxed frame, and no grant minted inside a link.
  expect(container!.querySelector("button")).toBeNull();
  expect(container!.querySelector("iframe")).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  const [media, html] = anchors();
  expect(media!.getAttribute("href")).toBe("https://example.com/post");
  expect(media!.textContent).toBe("recording");
  expect(html!.getAttribute("href")).toBe("/files/tmp/example/report.md");
  expect(html!.textContent).toBe("preview");
  for (const link of anchors()) expect(link.querySelector("a")).toBeNull();
});

it("leaves a standalone image embed bare, with no link wrapped around it", () => {
  render(`![the plot](${PLOT})`);
  expect(anchors()).toHaveLength(0);
  expect(container!.querySelector("img")?.getAttribute("loading")).toBe("lazy");
});
