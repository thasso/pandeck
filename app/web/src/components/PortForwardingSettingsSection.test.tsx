// @vitest-environment jsdom
/**
 * Settings → Port forwarding as the user drives it: what the form refuses
 * before the shell is asked, what a start and a stop send, what a row shows,
 * where a failure lands once its row is gone, and that the list keeps itself
 * current only while the page is visible.
 *   pnpm --filter @assistant/web test src/components/PortForwardingSettingsSection.test.tsx
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PortForwardTunnelStatus } from "@assistant/shared/portForwarding";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const shell = {
  supported: true,
  linksForward: true,
  list: vi.fn<() => Promise<PortForwardTunnelStatus[]>>(),
  start: vi.fn<(port: number) => Promise<PortForwardTunnelStatus>>(),
  stop: vi.fn<(port: number) => Promise<void>>(),
  open: vi.fn<(url: string) => Promise<void>>(),
};

vi.mock("../lib/nativeShell.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nativeShell.ts")>()),
  supportsNativePortForwarding: () => shell.supported,
  forwardsLoopbackLinks: () => shell.linksForward,
  listNativePortForwards: () => shell.list(),
  startNativePortForward: (port: number) => shell.start(port),
  stopNativePortForward: (port: number) => shell.stop(port),
  openNativePortForwardUrl: (url: string) => shell.open(url),
}));

const { PortForwardingSettingsSection } =
  await import("./PortForwardingSettingsSection.tsx");
const { PortForwardCancelledError, PortForwardRevokeError } =
  await import("../lib/nativeShell.ts");
const { getToasts, dismissToast } = await import("../lib/toast.ts");

const status = (
  port: number,
  extra: Partial<PortForwardTunnelStatus> = {},
): PortForwardTunnelStatus => ({
  port,
  localUrl: `http://localhost:${port}`,
  serverOrigin: "https://app.acme.test",
  activeConnections: 0,
  expiresAt: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
  ...extra,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  shell.supported = true;
  shell.linksForward = true;
  shell.list.mockReset();
  shell.start.mockReset();
  shell.stop.mockReset();
  shell.open.mockReset();
  shell.list.mockResolvedValue([]);
  shell.stop.mockResolvedValue(undefined);
  shell.open.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  for (const toast of getToasts()) dismissToast(toast.id);
  vi.useRealTimers();
});

async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PortForwardingSettingsSection />);
  });
}

const text = () => container!.textContent ?? "";
const input = () =>
  container!.querySelector<HTMLInputElement>("#port-forward-port")!;
const button = (label: string) =>
  [...container!.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const rowAlert = () => container!.querySelector('li [role="alert"]');

async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container!
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** The shell's list changed underneath the page: the next tick reads it. */
async function relist(forwards: PortForwardTunnelStatus[]) {
  shell.list.mockResolvedValue(forwards);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

it("explains itself where the shell cannot listen, instead of offering a form", async () => {
  shell.supported = false;
  await mount();
  expect(text()).toContain("needs the macOS app");
  expect(container!.querySelector("form")).toBeNull();
  expect(shell.list).not.toHaveBeenCalled();
});

it("refuses a port outside the range before asking the shell", async () => {
  await mount();
  expect(text()).toContain("No forward is running");
  expect(input().getAttribute("aria-describedby")).toBe(
    "port-forward-port-hint",
  );
  for (const value of ["", "80", "abc", "65536", "8080.5"]) {
    await type(value);
    await submit();
    expect(text(), value).toContain("Enter a port from 1024 to 65535.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().className).toContain("aria-invalid:border-destructive");
    // The refusal is part of the field's description, ahead of the hint.
    expect(input().getAttribute("aria-describedby")).toBe(
      "port-forward-port-error port-forward-port-hint",
    );
    expect(
      container!.querySelector("#port-forward-port-error")?.textContent,
    ).toContain("Enter a port from");
  }
  expect(shell.start).not.toHaveBeenCalled();
  // Editing clears the refusal.
  await type("5173");
  expect(text()).not.toContain("Enter a port from");
  expect(input().getAttribute("aria-invalid")).toBeNull();
  expect(input().classList.contains("border-destructive")).toBe(false);
});

it("refuses a port that is already forwarded before minting a grant", async () => {
  shell.list.mockResolvedValue([status(5173)]);
  await mount();
  await type("5173");
  await submit();
  expect(shell.start).not.toHaveBeenCalled();
  expect(text()).toContain("localhost:5173 is already forwarded.");
});

it("mentions localhost links in the empty state only where they forward", async () => {
  shell.linksForward = false;
  await mount();
  expect(text()).toContain("Start one above.");
  expect(text()).not.toContain("localhost link");
});

it("starts the typed port, then lists the forward with its facts", async () => {
  shell.start.mockImplementation(async (port) => {
    shell.list.mockResolvedValue([status(port, { activeConnections: 2 })]);
    return status(port);
  });
  await mount();
  await type(" 5173 ");
  await submit();
  expect(shell.start).toHaveBeenCalledWith(5173);
  expect(input().value).toBe("");
  expect(text()).toContain("http://localhost:5173");
  expect(text()).toContain("to app.acme.test");
  expect(text()).toContain("2 connections");
  expect(text()).toMatch(/expires in 2[23]h/);
  expect(text()).not.toContain("No forward is running");
});

it("shows a failed start in place and keeps the port typed", async () => {
  shell.start.mockRejectedValue(
    new Error("Could not listen on 127.0.0.1:5173: address in use"),
  );
  await mount();
  await type("5173");
  await submit();
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(
    "Could not listen on 127.0.0.1:5173",
  );
  expect(input().value).toBe("5173");
});

it("says nothing about the user's own Cancel and keeps the port typed", async () => {
  shell.start.mockRejectedValue(new PortForwardCancelledError());
  await mount();
  await type("5173");
  await submit();
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(getToasts()).toEqual([]);
  expect(input().value).toBe("5173");
});

it("opens a row in the browser and stops it through the shell", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  await mount();
  await act(async () => {
    button("Open").click();
  });
  expect(shell.open).toHaveBeenCalledWith("http://localhost:3000");

  shell.stop.mockImplementation(async () => {
    shell.list.mockResolvedValue([]);
  });
  await act(async () => {
    button("Stop").click();
  });
  expect(shell.stop).toHaveBeenCalledWith(3000);
  expect(text()).toContain("No forward is running");
});

it("keeps a failed row action on its row, until the forward is gone", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  shell.open.mockRejectedValue(
    new Error("No forward for localhost:3000 is running."),
  );
  await mount();
  await act(async () => {
    button("Open").click();
  });
  expect(rowAlert()?.textContent).toContain(
    "No forward for localhost:3000 is running.",
  );

  // The shell stops listing the port (expiry, a stop elsewhere): the error's
  // row is gone and so is the error, rather than lingering for the next
  // forward on the same port.
  await relist([]);
  expect(rowAlert()).toBeNull();
  await relist([status(3000)]);
  expect(rowAlert()).toBeNull();
});

it("clears a row's old error when the same port is started again", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  shell.open.mockRejectedValue(new Error("browser refused"));
  await mount();
  await act(async () => {
    button("Open").click();
  });
  expect(rowAlert()).not.toBeNull();
  await relist([]);
  shell.start.mockImplementation(async (port) => {
    shell.list.mockResolvedValue([status(port)]);
    return status(port);
  });
  await type("3000");
  await submit();
  expect(text()).toContain("http://localhost:3000");
  expect(rowAlert()).toBeNull();
});

it("keeps Stop usable while Open is busy, and announces a failure whose row went", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  let failOpen: (error: Error) => void = () => {};
  shell.open.mockReturnValue(
    new Promise<void>((_resolve, reject) => {
      failOpen = reject;
    }),
  );
  await mount();
  await act(async () => {
    button("Open").click();
  });
  expect(button("Open").disabled).toBe(true);
  expect(button("Stop").disabled).toBe(false);

  shell.stop.mockImplementation(async () => {
    shell.list.mockResolvedValue([]);
  });
  await act(async () => {
    button("Stop").click();
  });
  expect(shell.stop).toHaveBeenCalledWith(3000);
  expect(text()).toContain("No forward is running");

  // The Open that was still running fails after its row is gone: named in a
  // toast rather than lost with the row, and never as a row error.
  await act(async () => {
    failOpen(new Error("No forward for localhost:3000 is running."));
  });
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(getToasts()).toMatchObject([
    {
      tone: "error",
      message: "localhost:3000: No forward for localhost:3000 is running.",
    },
  ]);
});

it("drops the row when the listener stopped but the grant could not be revoked", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  shell.stop.mockImplementation(async (port) => {
    shell.list.mockResolvedValue([]);
    throw new PortForwardRevokeError(port, new Error("503"));
  });
  await mount();
  await act(async () => {
    button("Stop").click();
  });
  expect(text()).toContain("No forward is running");
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  expect(getToasts()).toMatchObject([
    {
      tone: "error",
      message:
        "The forward for localhost:3000 is stopped, but its server grant could not be revoked; it expires on its own.",
    },
  ]);
});

it("keeps the row and its error when the listener itself could not be stopped", async () => {
  shell.list.mockResolvedValue([status(3000)]);
  shell.stop.mockRejectedValue(
    new Error("Port-forward manager is unavailable."),
  );
  await mount();
  await act(async () => {
    button("Stop").click();
  });
  expect(text()).toContain("http://localhost:3000");
  expect(rowAlert()?.textContent).toContain(
    "Port-forward manager is unavailable.",
  );
  expect(getToasts()).toEqual([]);
});

it("labels a forward past its expiry as expired", async () => {
  shell.list.mockResolvedValue([
    status(3000, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
  ]);
  await mount();
  expect(text()).toContain("expired");
  expect(text()).not.toContain("expires in");
});

it("re-reads the list on a slow tick only while the page is visible", async () => {
  vi.useFakeTimers();
  await mount();
  expect(shell.list).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4000);
  });
  expect(shell.list).toHaveBeenCalledTimes(2);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(shell.list).toHaveBeenCalledTimes(2);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(shell.list).toHaveBeenCalledTimes(3);

  act(() => root?.unmount());
  root = null;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000);
  });
  expect(shell.list).toHaveBeenCalledTimes(3);
});
