// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentTarget } from "@assistant/shared/documentTargets";
import { DeferredGrantedMedia } from "./InlineDocumentEmbed.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let mints: number;
let ttlMs: number;

beforeEach(() => {
  vi.useFakeTimers();
  mints = 0;
  ttlMs = 10 * 60_000;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mints += 1;
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g${mints}/clip.mp3`,
          expiresAt: Date.now() + ttlMs,
          delivery: "inline",
        }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderAndPlay(
  target: DocumentTarget,
): Promise<HTMLAudioElement> {
  await act(async () => {
    root.render(
      <DeferredGrantedMedia kind="audio" target={target} label="clip.mp3" />,
    );
  });
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Play clip.mp3"]')!
      .click();
    await Promise.resolve();
  });
  const audio = container.querySelector("audio");
  expect(audio?.src).toContain("/api/file-grants/g1/clip.mp3");
  return audio!;
}

it("shows element failures and retries with a fresh artifact grant", async () => {
  const audio = await renderAndPlay({
    kind: "sessionArtifact",
    sessionId: "session-1",
    path: "clip.mp3",
  });
  act(() => {
    audio.dispatchEvent(new Event("error"));
  });
  expect(container.textContent).toContain("media link may have expired");

  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Retry media"))!
      .click();
    await Promise.resolve();
  });
  expect(mints).toBe(2);
  const request = JSON.parse(
    String((fetch as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body),
  ) as { fresh?: boolean; target: { kind: string } };
  expect(request).toMatchObject({
    fresh: true,
    target: { kind: "sessionArtifact" },
  });
  expect(container.querySelector("audio")?.src).toContain(
    "/api/file-grants/g2/clip.mp3",
  );
});

it("renews a playing Knowledge source before expiry and restores position", async () => {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  const audio = await renderAndPlay({
    kind: "knowledgeAsset",
    entryId: "entry-1",
    path: "assets/clip.mp3",
  });
  audio.currentTime = 37;
  Object.defineProperty(audio, "paused", { configurable: true, value: false });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(9 * 60_000);
  });
  expect(mints).toBe(2);
  const renewed = container.querySelector("audio")!;
  act(() => {
    renewed.dispatchEvent(new Event("loadedmetadata"));
  });
  expect(renewed.currentTime).toBe(37);
  expect(play).toHaveBeenCalled();
});

it("plays video inline rather than letting iOS take it fullscreen", async () => {
  const target = { kind: "hostFile" as const, path: "/tmp/clip.mp4" };
  await act(async () => {
    root.render(
      <DeferredGrantedMedia kind="video" target={target} label="clip.mp4" />,
    );
  });
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Play clip.mp4"]')!
      .click();
    await Promise.resolve();
  });
  expect(container.querySelector("video")?.hasAttribute("playsinline")).toBe(
    true,
  );
});

it("does not mint before Play, then renews an expired host grant on focus", async () => {
  ttlMs = 60 * 60_000;
  const target = { kind: "hostFile" as const, path: "/tmp/clip.mp3" };
  await act(async () => {
    root.render(
      <DeferredGrantedMedia kind="audio" target={target} label="clip.mp3" />,
    );
  });
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(mints).toBe(0);

  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Play clip.mp3"]')!
      .click();
    await Promise.resolve();
  });
  vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(mints).toBe(2);
});
