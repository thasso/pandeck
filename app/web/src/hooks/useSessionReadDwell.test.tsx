// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_READ_DWELL_MS } from "@assistant/shared";
import { useSessionReadDwell } from "./useSessionReadDwell.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ currentId }: { currentId: string | undefined }) {
  const readId = useSessionReadDwell(currentId);
  return <output data-read-id={readId ?? ""} />;
}

function render(currentId: string | undefined): void {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  act(() => root!.render(<Probe currentId={currentId} />));
}

function readId(): string {
  return container?.querySelector("output")?.dataset.readId ?? "";
}

function advance(ms: number): void {
  act(() => void vi.advanceTimersByTime(ms));
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("useSessionReadDwell", () => {
  it("waits the full dwell on first open and every route switch", () => {
    vi.useFakeTimers();

    render("a");
    expect(readId()).toBe("");
    advance(SESSION_READ_DWELL_MS - 1);
    expect(readId()).toBe("");
    advance(1);
    expect(readId()).toBe("a");

    render("b");
    expect(readId()).toBe("");
    advance(SESSION_READ_DWELL_MS);
    expect(readId()).toBe("b");
  });

  it("never reports the session just left while the next dwell is pending", () => {
    vi.useFakeTimers();
    render("a");
    advance(SESSION_READ_DWELL_MS);
    expect(readId()).toBe("a");

    render("b");
    expect(readId()).toBe("");
    render(undefined);
    expect(readId()).toBe("");
  });
});
