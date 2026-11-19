// @vitest-environment jsdom
/**
 * The gateway page's request log (Task-1430) over a mocked reader: the
 * cursor and its reset on a new epoch, polling only while visible, the
 * abort on unmount, catching up on full pages, the bound on what is kept and
 * shown, the highlights and the filters.
 */
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  GatewayUiRequest,
  GatewayUiRequests,
} from "@assistant/shared/gatewayUi";
import { mount } from "../test/mount.tsx";
import { GatewayApiError } from "./gatewayApi.ts";
import {
  GatewayRequests,
  KEPT,
  POLL_MS,
  SHOWN,
  type GatewayRequestsProps,
} from "./GatewayRequests.tsx";

const E1 = "1".repeat(32);
const E2 = "2".repeat(32);

function record(
  seq: number,
  over: Partial<GatewayUiRequest> = {},
): GatewayUiRequest {
  return {
    seq,
    epoch: E1,
    at: Date.UTC(2026, 10, 18, 12, 0, seq % 60),
    client: { id: "c1", label: "Laptop" },
    via: "gateway",
    host: "api.anthropic.com",
    method: "POST",
    path: `/v1/messages/${seq}`,
    pathKey: `/v1/messages/${seq}`,
    status: 200,
    outcome: "forwarded",
    clientCredential: "placeholder",
    clientCookie: false,
    requestBytes: 100,
    responseBytes: 2_048,
    durationMs: 12,
    firstSeen: false,
    ...over,
  };
}

const page = (epoch: string, requests: GatewayUiRequest[]) => ({
  epoch,
  requests,
});

type Fetch = GatewayRequestsProps["fetchRequests"];

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function render(fetchRequests: Fetch) {
  const mounted = mount();
  await act(async () => {
    mounted.render(<GatewayRequests fetchRequests={fetchRequests} />);
  });
  return mounted.container;
}

const seqs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("tr[data-seq]")].map((row) =>
    Number(row.dataset.seq),
  );

const cursors = (fetch: ReturnType<typeof vi.fn<Fetch>>) =>
  fetch.mock.calls.map(([epoch, after]) => [epoch, after]);

test("reads from the cursor, appends, and starts over on a new epoch", async () => {
  const fetch = vi.fn<Fetch>();
  fetch
    .mockResolvedValueOnce(page(E1, [record(1), record(2)]))
    .mockResolvedValueOnce(page(E1, [record(3)]))
    .mockResolvedValueOnce(page(E1, []))
    // The gateway restarted: its answer starts over from its own first record.
    .mockResolvedValueOnce(
      page(E2, [record(1, { epoch: E2 }), record(2, { epoch: E2 })]),
    )
    .mockResolvedValue(page(E2, []));
  const container = await render(fetch);
  expect(seqs(container)).toEqual([2, 1]);
  await advance(POLL_MS);
  expect(seqs(container)).toEqual([3, 2, 1]);
  await advance(POLL_MS);
  await advance(POLL_MS);
  // Only the new epoch's records remain, newest first.
  expect(seqs(container)).toEqual([2, 1]);
  expect(container.textContent).not.toContain("/v1/messages/3");
  await advance(POLL_MS);
  expect(cursors(fetch)).toEqual([
    [undefined, 0],
    [E1, 2],
    [E1, 3],
    [E1, 3],
    [E2, 2],
  ]);
});

test("a record the cursor already passed is not shown twice", async () => {
  const fetch = vi.fn<Fetch>();
  fetch
    .mockResolvedValueOnce(page(E1, [record(1), record(2)]))
    .mockResolvedValueOnce(page(E1, [record(2), record(3)]))
    .mockResolvedValue(page(E1, []));
  const container = await render(fetch);
  await advance(POLL_MS);
  expect(seqs(container)).toEqual([3, 2, 1]);
});

test("polls only while visible and reads at once when visible again", async () => {
  const fetch = vi.fn<Fetch>().mockResolvedValue(page(E1, []));
  visibility = "hidden";
  await render(fetch);
  await advance(POLL_MS * 4);
  expect(fetch).not.toHaveBeenCalled();
  await setVisibility("visible");
  await advance(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  await advance(POLL_MS);
  expect(fetch).toHaveBeenCalledTimes(2);
  await setVisibility("hidden");
  await advance(POLL_MS * 4);
  expect(fetch).toHaveBeenCalledTimes(2);
  await setVisibility("visible");
  await advance(0);
  expect(fetch).toHaveBeenCalledTimes(3);
  // One loop: a second visibility event does not start another.
  await setVisibility("visible");
  await advance(POLL_MS);
  expect(fetch).toHaveBeenCalledTimes(4);
});

test("unmounting aborts the read in flight and drops its answer", async () => {
  let resolve!: (value: GatewayUiRequests) => void;
  let signal!: AbortSignal;
  const fetch = vi.fn<Fetch>((_epoch, _after, s) => {
    signal = s;
    return new Promise((r) => (resolve = r));
  });
  const mounted = mount();
  await act(async () => {
    mounted.render(<GatewayRequests fetchRequests={fetch} />);
  });
  const error = vi.spyOn(console, "error");
  act(() => mounted.root.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(page(E1, [record(1)])));
  await advance(POLL_MS * 3);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
});

test("full pages are read again at once; the page keeps and shows a bounded number", async () => {
  let next = 1;
  const full = () =>
    page(
      E1,
      Array.from({ length: 500 }, () => record(next++)),
    );
  const fetch = vi.fn<Fetch>();
  for (let i = 0; i < 5; i += 1)
    fetch.mockImplementationOnce(async () => full());
  fetch.mockResolvedValue(page(E1, []));
  const container = await render(fetch);
  // Each catch-up read is due at once (well inside 5 ms), not after the
  // poll interval.
  for (let i = 0; i < 5; i += 1) await advance(1);
  expect(fetch).toHaveBeenCalledTimes(6);
  expect(fetch.mock.calls[5]![1]).toBe(2_500);
  const rows = seqs(container);
  expect(rows).toHaveLength(SHOWN);
  expect(rows[0]).toBe(2_500);
  expect(container.textContent).toContain(
    `Showing the newest ${SHOWN} of ${KEPT} matching requests.`,
  );
});

test("a failed read keeps the records, says so, and recovers", async () => {
  const fetch = vi.fn<Fetch>();
  fetch
    .mockResolvedValueOnce(page(E1, [record(1)]))
    .mockRejectedValueOnce(new GatewayApiError(503, "unavailable"))
    .mockResolvedValueOnce(page(E1, [record(2)]))
    .mockRejectedValueOnce(new GatewayApiError(401, "signed_out"));
  const container = await render(fetch);
  await advance(POLL_MS);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "could not read your requests",
  );
  expect(seqs(container)).toEqual([1]);
  await advance(POLL_MS);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(seqs(container)).toEqual([2, 1]);
  await advance(POLL_MS);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Your session ended.",
  );
});

test("empty: says so once the gateway answered", async () => {
  const container = await render(
    vi.fn<Fetch>().mockResolvedValue(page(E1, [])),
  );
  expect(container.textContent).toContain(
    "No requests from your clients since the gateway last started.",
  );
  expect(container.textContent).toContain("keeps the last 5,000");
});

test("new and unlisted requests are marked, and the filters narrow the list", async () => {
  const fetch = vi.fn<Fetch>().mockResolvedValueOnce(
    page(E1, [
      record(1, { firstSeen: true }),
      record(2, { listed: false, account: "Work", session: "0123456789ab" }),
      record(3, { listed: true }),
      record(4, {
        outcome: "refused",
        status: 403,
        reason: "forbidden",
        clientCredential: "other",
        clientCookie: true,
      }),
      record(5, { outcome: "failed", status: null, reason: "client-closed" }),
      record(6, { clientCredential: "mcp-token" }),
    ]),
  );
  fetch.mockResolvedValue(page(E1, []));
  const container = await render(fetch);
  const row = (seq: number) =>
    container.querySelector<HTMLElement>(`tr[data-seq="${seq}"]`)!;
  expect(row(1).textContent).toContain("New");
  expect(row(1).className).toContain("bg-warning-soft");
  expect(row(2).textContent).toContain("Unlisted");
  expect(row(2).textContent).toContain("Work");
  expect(row(2).textContent).toContain("0123456789ab");
  expect(row(2).className).toContain("bg-warning-soft");
  expect(row(3).textContent).not.toContain("Unlisted");
  expect(row(3).className).not.toContain("bg-warning-soft");
  expect(row(4).textContent).toContain("forbidden");
  expect(row(4).textContent).toContain("cookie");
  expect(row(5).textContent).toContain("–");
  expect(row(6).textContent).toContain("mcp-token");

  const switches = container.querySelectorAll<HTMLElement>('[role="switch"]');
  expect(switches).toHaveLength(2);
  await act(async () => switches[0]!.click());
  expect(seqs(container)).toEqual([1]);
  await act(async () => switches[0]!.click());
  await act(async () => switches[1]!.click());
  expect(seqs(container)).toEqual([2]);
  await act(async () => switches[1]!.click());

  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "refused";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(seqs(container)).toEqual([4]);
  await act(async () => {
    select.value = "overflow";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(seqs(container)).toEqual([]);
  expect(container.textContent).toContain("No request matches these filters.");
});
