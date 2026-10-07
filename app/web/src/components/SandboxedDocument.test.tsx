// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SandboxedDocument } from "./SandboxedDocument.tsx";

/**
 * A grant DIES on a fixed deadline and the server never extends one on a read
 * (`docs/served-files.md`), so the client is what keeps a mounted document
 * alive. Everything here is about that: renewal before the deadline, renewal
 * after a page came back from being frozen (where the timer never ran), and the
 * viewer's reload reaching the document at all.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** The engine's answer to "can a reader scroll a framed PDF here?". */
const engine = vi.hoisted(() => ({ scrollsEmbeddedPdf: true }));
vi.mock("../lib/embeddedPdf.ts", () => ({
  embeddedPdfScrolls: () => engine.scrollsEmbeddedPdf,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let mints = 0;

/** Each mint answers with its own URL and a deadline `ttlMs` out. */
function stubMint(ttlMs: number): void {
  mints = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mints += 1;
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g${mints}/page.html`,
          expiresAt: Date.now() + ttlMs,
          delivery: "inline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

async function render(generation = 0): Promise<void> {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.append(container);
  root ??= createRoot(container);
  await act(async () => {
    root!.render(
      <SandboxedDocument
        target={{ kind: "hostFile", path: "/tmp/example/report/page.html" }}
        showOpenAction
        generation={generation}
      />,
    );
  });
}

const frameSrc = () =>
  container!.querySelector("iframe")?.getAttribute("src") ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  engine.scrollsEmbeddedPdf = true;
  (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__ = "tok-1";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-native-shell");
  delete window.__TAURI__;
  delete (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__;
});

it("renews before the deadline and points the active sandbox at the new grant", async () => {
  stubMint(10 * 60_000);
  await render();
  expect(mints).toBe(1);
  expect(frameSrc()).toContain("/api/file-grants/g1/page.html");
  expect(
    container!.querySelector("iframe")?.getAttribute("sandbox"),
  ).not.toContain("allow-same-origin");

  // Just short of the renewal margin: nothing to do yet.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8 * 60_000);
  });
  expect(mints).toBe(1);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(mints).toBe(2);
  expect(frameSrc()).toContain("/api/file-grants/g2/page.html");
});

it("lets passive file-scoped PDF use the browser renderer without iframe sandbox", async () => {
  stubMint(10 * 60_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SandboxedDocument
        target={{ kind: "hostFile", path: "/tmp/example/report.pdf" }}
        scope="file"
        contentPolicy="passive-pdf"
      />,
    );
  });
  expect(container.querySelector("iframe")?.hasAttribute("sandbox")).toBe(
    false,
  );
  const body = JSON.parse(
    String((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body),
  ) as { scope: string };
  expect(body.scope).toBe("file");
});

/** The dedicated viewer's PDF, as `FileViewerPage` and the other viewers ask for it. */
async function renderPdf(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SandboxedDocument
        target={{ kind: "hostFile", path: "/tmp/example/report.pdf" }}
        scope="file"
        contentPolicy="passive-pdf"
        sizeBytes={2 * 1024 * 1024}
        className="h-full w-full"
      />,
    );
  });
}

it("offers a PDF a real browser tab where a framed one cannot be scrolled", async () => {
  // iOS/iPadOS WebKit: the frame would show page one at native size, immovable.
  engine.scrollsEmbeddedPdf = false;
  stubMint(10 * 60_000);
  await renderPdf();

  expect(container!.querySelector("iframe")).toBeNull();
  expect(container!.textContent).toContain("report.pdf");
  expect(container!.textContent).toContain("2.0 MB");
  const action = container!.querySelector<HTMLAnchorElement>("a")!;
  expect(action.textContent).toContain("Open PDF");
  expect(action.getAttribute("href")).toContain(
    "/api/file-grants/g1/page.html",
  );
  expect(action.getAttribute("target")).toBe("_blank");
  // A navigation keeps link semantics; a Base UI button would add role=button.
  expect(action.getAttribute("role")).toBeNull();
});

it("renders the in-frame open action as a named link, not a button", async () => {
  stubMint(10 * 60_000);
  await render();
  const action = container!.querySelector<HTMLAnchorElement>("a")!;
  expect(action.getAttribute("role")).toBeNull();
  expect(action.getAttribute("aria-label")).toBe(
    "Open this document in a new tab",
  );
  expect(action.getAttribute("href")).toContain(
    "/api/file-grants/g1/page.html",
  );
  expect(action.getAttribute("target")).toBe("_blank");
});

it("keeps the embedded PDF frame on an engine that scrolls one", async () => {
  stubMint(10 * 60_000);
  await renderPdf();

  expect(frameSrc()).toContain("/api/file-grants/g1/page.html");
  expect(container!.textContent).not.toContain("Open PDF");
});

it("keeps the active sandbox if passive policy is mistakenly paired with directory scope", async () => {
  stubMint(10 * 60_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SandboxedDocument
        target={{ kind: "hostFile", path: "/tmp/example/report.html" }}
        contentPolicy="passive-pdf"
      />,
    );
  });
  expect(container.querySelector("iframe")?.hasAttribute("sandbox")).toBe(true);
});

it("gives the frame a parent that carries the height a viewer asked for", async () => {
  stubMint(10 * 60_000);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <SandboxedDocument
        target={{ kind: "hostFile", path: "/tmp/example/report/page.html" }}
        className="h-full w-full"
      />,
    );
  });
  const frame = container.querySelector("iframe")!;
  // `h-full` on the frame alone is 100% of an auto-height parent, which is
  // auto — an iframe then falls back to the browser's 150px default.
  expect(frame.parentElement?.className).toContain("h-full");
});

it("renews when a frozen page comes back with its timer un-run", async () => {
  stubMint(10 * 60_000);
  await render();
  expect(mints).toBe(1);

  // A sleeping device: real time passed, the timeout never fired. Faking the
  // clock without running timers is exactly that state.
  vi.setSystemTime(Date.now() + 20 * 60_000);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(mints).toBe(2);
  expect(frameSrc()).toContain("/api/file-grants/g2/page.html");
});

it("leaves a live grant alone when the page comes back", async () => {
  stubMint(60 * 60_000);
  await render();
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(mints).toBe(1);
});

it("re-mints on a generation bump, which is the viewer's reload", async () => {
  stubMint(60 * 60_000);
  await render(0);
  expect(mints).toBe(1);
  await render(1);
  expect(mints).toBe(2);
  expect(frameSrc()).toContain("/api/file-grants/g2/page.html");
});

/** A stand-in for the tab `window.open` hands back, with no `opener` promise. */
function fakeTab() {
  return {
    opener: {} as unknown,
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

function clickOpenAction(): Promise<void> {
  const anchor = container!.querySelector<HTMLAnchorElement>("a")!;
  return act(async () => {
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

it("re-mints before native open while a resume refresh is in flight", async () => {
  document.documentElement.setAttribute("data-native-shell", "macos");
  const invoke = vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => undefined,
  );
  window.__TAURI__ = { core: { invoke } };
  mints = 0;
  let releaseResumeRefresh!: () => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      mints += 1;
      const mint = mints;
      if (mint === 2)
        await new Promise<void>((resolve) => {
          releaseResumeRefresh = resolve;
        });
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g${mint}/page.html`,
          expiresAt: Date.now() + 10 * 60_000,
          delivery: "inline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  await render();

  vi.setSystemTime(Date.now() + 20 * 60_000);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(mints).toBe(2); // g2 is the still-pending resume refresh.
  await clickOpenAction();

  expect(invoke).toHaveBeenCalledWith("open_served_file", {
    url: expect.stringContaining("/api/file-grants/g3/page.html"),
  });
  const invokedUrl = String(
    (invoke.mock.calls[0]?.[1] as { url?: string } | undefined)?.url,
  );
  expect(invokedUrl).not.toContain("/api/file-grants/g1/");
  expect(invokedUrl).not.toContain("/api/file-grants/g2/");
  await act(async () => releaseResumeRefresh());
});

it("navigates a tab it opened SYNCHRONOUSLY to the fresh url", async () => {
  stubMint(10 * 60_000);
  await render();
  const tab = fakeTab();
  const open = vi.fn(() => tab as unknown as Window);
  vi.stubGlobal("open", open);

  vi.setSystemTime(Date.now() + 20 * 60_000);
  await clickOpenAction();

  // Opened blank first, because a popup blocker refuses a window opened after
  // an await; then pointed at the newly minted grant, not the dead g1.
  expect(open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  expect(tab.location.replace).toHaveBeenCalledWith(
    expect.stringContaining("/api/file-grants/g2/page.html"),
  );
  expect(tab.close).not.toHaveBeenCalled();
});

it("does not navigate the app away when the tab opened successfully", async () => {
  // `window.open(url, "_blank", "noopener")` answers null even on SUCCESS, so a
  // fallback keyed on the return value would send the reader's own tab to the
  // document and lose the app.
  stubMint(10 * 60_000);
  await render();
  const open = vi.fn(() => fakeTab() as unknown as Window);
  vi.stubGlobal("open", open);

  vi.setSystemTime(Date.now() + 20 * 60_000);
  await clickOpenAction();
  // One call, for the blank tab. Nothing navigated THIS tab.
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalledWith(expect.anything(), "_self");
});

it("falls back to this tab when the popup is blocked", async () => {
  stubMint(10 * 60_000);
  await render();
  const open = vi.fn(() => null);
  vi.stubGlobal("open", open);

  vi.setSystemTime(Date.now() + 20 * 60_000);
  await clickOpenAction();
  // The reader asked for the document; doing nothing would be worse.
  expect(open).toHaveBeenLastCalledWith(
    expect.stringContaining("/api/file-grants/g2/page.html"),
    "_self",
  );
});

it("closes the blank tab and surfaces the failure when the mint fails", async () => {
  stubMint(10 * 60_000);
  await render();
  const tab = fakeTab();
  vi.stubGlobal(
    "open",
    vi.fn(() => tab as unknown as Window),
  );
  // Every mint from here on fails: the click's, and the renewal after it.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("no such file", { status: 404 })),
  );

  vi.setSystemTime(Date.now() + 20 * 60_000);
  await clickOpenAction();

  expect(tab.close).toHaveBeenCalled();
  expect(tab.location.replace).not.toHaveBeenCalled();
  // The error has a home on screen rather than in an unhandled rejection.
  await act(async () => {
    await Promise.resolve();
  });
  expect(container!.textContent).toContain("no such file");
});
