// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

/**
 * Task 636: an agent shows an image by writing a Markdown image whose source is
 * a session artifact. Two things have to hold for that to be worth anything —
 * the picture must LOAD (origin + token, not the bare API path, which a
 * dev-server page would resolve against Vite and a served page would get a 401
 * for), and explicit embed intent must stay a bare lazy image rather than card
 * chrome — one that still enlarges, since a chat-sized screenshot is rarely
 * legible in the flow. An image the app does not serve is left as authored.
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
  delete (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__;
});

function render(text: string): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<Markdown text={text} />));
}

const ARTIFACT = "/api/session-artifacts/session-a/browser/page.png";

it("loads an artifact image from the token-bearing server URL", () => {
  (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__ = "secret";
  render(`Here is the page:\n\n![The settings page](${ARTIFACT})`);

  // Absolute (the API server's origin, which is a different port under Vite)
  // and carrying the token an `<img>` cannot send as a header.
  const image = document.querySelector("img")!;
  const src = new URL(image.getAttribute("src")!);
  expect(src.protocol).toMatch(/^https?:$/);
  expect(src.pathname).toBe(ARTIFACT);
  expect(src.searchParams.get("token")).toBe("secret");
  expect(image.getAttribute("alt")).toBe("The settings page");
  expect(image.getAttribute("loading")).toBe("lazy");
  expect(container!.textContent).not.toContain("Preview only");
});

it("uses no card chrome for an artifact image", () => {
  render(`![shot](${ARTIFACT})`);
  expect(container!.querySelectorAll("img")).toHaveLength(1);
  expect(container!.textContent).toBe("");
  expect(container!.querySelector('[role="dialog"]')).toBeNull();
});

it("enlarges a standalone artifact image in the full-screen viewer", () => {
  render(`![shot](${ARTIFACT})`);
  const enlarge = container!.querySelector<HTMLButtonElement>(
    'button[title="Click to enlarge"]',
  )!;
  expect(enlarge.getAttribute("aria-label")).toBe("Enlarge shot");
  act(() => enlarge.click());

  const viewer = document.querySelector('[role="dialog"]')!;
  expect(viewer).not.toBeNull();
  expect(viewer.querySelector("img")?.getAttribute("src")).toBe(
    container!.querySelector("img")!.getAttribute("src"),
  );
  act(() =>
    viewer
      .querySelector<HTMLButtonElement>('[aria-label="Close image viewer"]')!
      .click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps the picture inside an authored link inert", () => {
  render(`[![shot](${ARTIFACT})](https://example.com/page)`);
  const link = container!.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com/page");
  expect(link.querySelector("img")).not.toBeNull();
  expect(container!.querySelector("button")).toBeNull();
});

it("leaves an image the app does not serve exactly as authored", () => {
  render("![a diagram](https://example.com/diagram.png)");

  const image = document.querySelector("img")!;
  expect(image.getAttribute("src")).toBe("https://example.com/diagram.png");
  expect(
    container!.querySelector('button[title="Click to enlarge"]'),
  ).toBeNull();
});
