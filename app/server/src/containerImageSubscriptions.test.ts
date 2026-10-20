import { existsSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  pullContainerImage,
  setContainerExecForTests,
  type ContainerExecRequest,
  type ContainerExecResult,
} from "./containerImages.ts";

const cleanupHook = vi.hoisted(() => ({
  next: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>) {
      await actual.rm(...args);
      const next = cleanupHook.next;
      cleanupHook.next = undefined;
      // Start a caller just before runPull's finally resumes and releases its slot.
      if (next) queueMicrotask(next);
    },
  };
});
const OK = { code: 0, stdout: "", stderr: "" };
interface Pull {
  request: ContainerExecRequest;
  finish(result?: ContainerExecResult): void;
}
function gatedExec() {
  const pulls: Pull[] = [];
  let active = 0;
  let peak = 0;
  setContainerExecForTests(async (request) => {
    if (request.args[0] === "version") return { ...OK, stdout: "29" };
    if (request.args[0] !== "pull") return OK;
    active++;
    peak = Math.max(peak, active);
    try {
      return await new Promise<ContainerExecResult>((resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        request.signal?.addEventListener("abort", abort, { once: true });
        pulls.push({
          request,
          finish: (result = OK) => {
            request.signal?.removeEventListener("abort", abort);
            resolve(result);
          },
        });
        if (request.signal?.aborted) abort();
      });
    } finally {
      active--;
    }
  });
  return { pulls, peak: () => peak, active: () => active };
}
const call = (
  image: string,
  signal?: AbortSignal,
  timeoutMs?: number,
  onProgress?: (s: string) => void,
) =>
  pullContainerImage({
    image,
    refresh: true,
    ...(signal ? { signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(onProgress ? { onProgress } : {}),
  });
afterEach(() => {
  setContainerExecForTests(null);
  cleanupHook.next = undefined;
  vi.useRealTimers();
});

describe("shared pull subscriptions", () => {
  test.each([
    [undefined, 600_000, 0],
    [undefined, 600_000, 1],
    [300_000, 600_000, 0],
    [300_000, 600_000, 1],
  ])(
    "isolates cancellation with budgets %s/%s and caller %s leaving",
    async (aBudget, bBudget, leaving) => {
      const exec = gatedExec();
      const controllers = [new AbortController(), new AbortController()];
      const a = call("node:24", controllers[0]!.signal, aBudget);
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
      const b = call("node:24", controllers[1]!.signal, bBudget);
      const promises = [a, b];
      const cancelled = promises[leaving]!.catch((error: Error) => error);
      controllers[leaving]!.abort();
      expect(await cancelled).toMatchObject({
        message: expect.stringContaining("was cancelled"),
      });
      expect(exec.pulls[0]!.request.signal?.aborted).toBe(false);
      exec.pulls[0]!.finish();
      await expect(promises[1 - leaving]).resolves.toMatchObject({
        status: "pulled",
      });
      expect(exec.pulls).toHaveLength(1);
    },
  );
  test.each([false, true])(
    "unequal timers are independent, long caller first=%s",
    async (longFirst) => {
      vi.useFakeTimers();
      const exec = gatedExec();
      const first = call("node:24", undefined, longFirst ? 300_000 : 60_000);
      const firstResult = first.catch((e: Error) => e);
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
      const second = call("node:24", undefined, longFirst ? 60_000 : 300_000);
      const secondResult = second.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await (longFirst ? secondResult : firstResult)).toMatchObject({
        message:
          "Pull of docker.io/library/node:24 did not finish within 60 s.",
      });
      expect(exec.pulls[0]!.request.signal?.aborted).toBe(false);
      expect(exec.pulls[0]!.request.timeoutMs).toBe(900_000);
      exec.pulls[0]!.finish();
      await expect(longFirst ? first : second).resolves.toMatchObject({
        status: "pulled",
      });
    },
  );
  test.each([undefined, 900_000])(
    "each foreground caller has its own default timer, later budget=%s",
    async (laterBudget) => {
      vi.useFakeTimers();
      const exec = gatedExec();
      const first = call("node:24").catch((e: Error) => e);
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(300_000);
      const later = call("node:24", undefined, laterBudget);
      // This fake deliberately holds docker past its command timeout to isolate caller timers.
      // The safety-limit test below checks the independent command limit and shared failure.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await first).toMatchObject({
        message:
          "Pull of docker.io/library/node:24 did not finish within 900 s.",
      });
      expect(exec.pulls[0]!.request.signal?.aborted).toBe(false);
      exec.pulls[0]!.finish();
      await expect(later).resolves.toMatchObject({ status: "pulled" });
    },
  );
  test.each(["cancel", "timeout", "default-timeout"])(
    "a queued subscriber settles on %s and never runs; slots stay bounded",
    async (exit) => {
      vi.useFakeTimers();
      const exec = gatedExec();
      // Keep the slot holders alive longer than the queued caller to isolate queue time.
      const a = call("node:22", undefined, 2_000_000);
      const b = call("node:24", undefined, 2_000_000);
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(2));
      const controller = new AbortController();
      const queued = call(
        "node:26",
        controller.signal,
        exit === "default-timeout" ? undefined : 60_000,
      ).catch((e: Error) => e);
      if (exit === "cancel") controller.abort();
      else
        await vi.advanceTimersByTimeAsync(
          exit === "default-timeout" ? 900_000 : 60_000,
        );
      expect(await queued).toBeInstanceOf(Error);
      exec.pulls[0]!.finish();
      exec.pulls[1]!.finish();
      // Released capacity serves new pulls, never the cancelled queued image.
      const c = call("node:28");
      const d = call("node:30");
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(4));
      expect(
        exec.pulls.some((p) =>
          p.request.args.includes("docker.io/library/node:26"),
        ),
      ).toBe(false);
      expect(exec.peak()).toBe(2);
      exec.pulls[2]!.finish();
      exec.pulls[3]!.finish();
      await Promise.all([a, b, c, d]);
    },
  );
  test.each(["cancel", "timeout"])(
    "last subscriber %s aborts the operation, cleans up and permits rejoin",
    async (exit) => {
      vi.useFakeTimers();
      const exec = gatedExec();
      const controller = new AbortController();
      const first = call("node:24", controller.signal, 60_000).catch(
        (e: Error) => e,
      );
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
      const dir = exec.pulls[0]!.request.env!.DOCKER_CONFIG!;
      if (exit === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(60_000);
      expect(await first).toBeInstanceOf(Error);
      expect(exec.pulls[0]!.request.signal?.aborted).toBe(true);
      const next = call("node:24");
      await vi.waitFor(() => expect(exec.pulls).toHaveLength(2));
      await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
      exec.pulls[1]!.finish();
      await next;
    },
  );
  test("shared safety failure reaches every subscriber and docker always has its fixed limit", async () => {
    const exec = gatedExec();
    const a = call("node:24", undefined, 60_000).catch((e: Error) => e);
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
    const b = call("node:24", undefined, 300_000).catch((e: Error) => e);
    expect(exec.pulls[0]!.request.timeoutMs).toBe(900_000);
    exec.pulls[0]!.finish({
      code: 1,
      stdout: "",
      stderr: "docker was terminated by SIGTERM",
    });
    expect(await a).toMatchObject({
      message:
        "Pull of docker.io/library/node:24 failed: docker was terminated by SIGTERM",
    });
    expect(await b).toEqual(await a);
  });
  test("progress fans out after the joiner's waiting line", async () => {
    const exec = gatedExec();
    const first = vi.fn();
    const second = vi.fn();
    const a = call("node:24", undefined, undefined, first);
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(1));
    const b = call("node:24", undefined, undefined, second);
    expect(second.mock.calls[0]![0]).toContain(
      "Waiting for an in-progress pull",
    );
    exec.pulls[0]!.request.onStdoutLine?.("Downloading layer");
    expect(first.mock.calls.at(-1)).toEqual(second.mock.calls.at(-1));
    exec.pulls[0]!.finish();
    await Promise.all([a, b]);
  });
  test("a queued joiner leaves without cancelling its surviving subscriber", async () => {
    const exec = gatedExec();
    const a = call("node:22");
    const b = call("node:24");
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(2));
    const surviving = call("node:26");
    const controller = new AbortController();
    const leaving = call("node:26", controller.signal).catch((e: Error) => e);
    controller.abort();
    expect(await leaving).toBeInstanceOf(Error);
    exec.pulls[0]!.finish();
    const newcomer = call("node:28");
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(3));
    expect(exec.pulls[2]!.request.args).toContain("docker.io/library/node:26");
    expect(exec.peak()).toBe(2);
    exec.pulls[1]!.finish();
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(4));
    exec.pulls[2]!.finish();
    exec.pulls[3]!.finish();
    await Promise.all([a, b, surviving, newcomer]);
    expect(exec.peak()).toBe(2);
  });
  test("slot handoff stays within capacity when a fresh acquire races its live waiter", async () => {
    const exec = gatedExec();
    const a = call("node:22");
    const b = call("node:24");
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(2));
    const waiting = call("node:26");
    let newcomer: Promise<unknown> | undefined;
    cleanupHook.next = () => {
      newcomer = call("node:28");
    };
    exec.pulls[0]!.finish();
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(3));
    expect(exec.pulls[2]!.request.args).toContain("docker.io/library/node:26");
    expect(exec.peak()).toBe(2);
    exec.pulls[1]!.finish();
    await vi.waitFor(() => expect(exec.pulls).toHaveLength(4));
    exec.pulls[2]!.finish();
    exec.pulls[3]!.finish();
    await Promise.all([a, b, waiting, newcomer]);
    expect(exec.peak()).toBe(2);
  });
  test("already-aborted callers start nothing", async () => {
    const exec = gatedExec();
    await expect(call("node:24", AbortSignal.abort())).rejects.toThrow(
      "was cancelled",
    );
    expect(exec.pulls).toHaveLength(0);
  });
});
