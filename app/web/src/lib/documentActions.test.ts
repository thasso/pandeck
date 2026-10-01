// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  externalDocumentActionEnabled,
  runExternalDocumentAction,
} from "./documentActions.ts";
import { serverHttpOrigin } from "./serverOrigin.ts";

function requestBodyOf(spy: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  const init = spy.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-native-shell");
  delete window.__TAURI__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("mints a single-resource grant before asking Tauri to open a host file", async () => {
  document.documentElement.setAttribute("data-native-shell", "macos");
  const invoke = vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => undefined,
  );
  window.__TAURI__ = { core: { invoke } };
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/grant-1/report.txt",
          expiresAt: Date.now() + 60_000,
          delivery: "inline",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  await runExternalDocumentAction(
    { kind: "hostFile", path: "/tmp/report.txt" },
    "open",
  );

  const requestUrl = new URL(String(fetchSpy.mock.calls[0]?.[0]));
  expect(requestUrl.pathname).toBe("/api/file-grants");
  expect(requestUrl.search).toBe("");
  expect(requestBodyOf(fetchSpy)).toMatchObject({
    target: { kind: "hostFile", path: "/tmp/report.txt" },
    scope: "file",
    delivery: "inline",
  });
  const invokedUrl = String(
    (invoke.mock.calls[0]?.[1] as { url?: string } | undefined)?.url,
  );
  expect(invokedUrl).toBe(
    `${serverHttpOrigin()}/api/file-grants/grant-1/report.txt`,
  );
  expect(new URL(invokedUrl).search).toBe("");
});

it("keeps runnable host HTML Open directory-scoped and inline", async () => {
  document.documentElement.setAttribute("data-native-shell", "macos");
  const invoke = vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => undefined,
  );
  window.__TAURI__ = { core: { invoke } };
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/html-1/report.html",
          expiresAt: Date.now() + 60_000,
          delivery: "inline",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  await runExternalDocumentAction(
    { kind: "hostFile", path: "/tmp/report.html" },
    "open",
  );
  expect(requestBodyOf(fetchSpy)).toMatchObject({
    target: { kind: "hostFile", path: "/tmp/report.html" },
    scope: "directory",
    delivery: "inline",
  });
});

it("binds native Download to a file-scoped attachment grant", async () => {
  document.documentElement.setAttribute("data-native-shell", "ios");
  const invoke = vi.fn(
    async (_command: string, _args?: Record<string, unknown>) => undefined,
  );
  window.__TAURI__ = { core: { invoke } };
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/download-1/report.pdf",
          expiresAt: Date.now() + 60_000,
          delivery: "attachment",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  await runExternalDocumentAction(
    { kind: "hostFile", path: "/tmp/report.pdf" },
    "download",
  );
  expect(requestBodyOf(fetchSpy)).toMatchObject({
    target: { kind: "hostFile", path: "/tmp/report.pdf" },
    scope: "file",
    delivery: "attachment",
  });
  expect(invoke).toHaveBeenCalledWith("open_served_file", {
    url: `${serverHttpOrigin()}/api/file-grants/download-1/report.pdf`,
  });
});

it("navigates a reserved browser tab to the token-free attachment grant", async () => {
  const replace = vi.fn();
  const tab = {
    location: { replace },
    close: vi.fn(),
    opener: window,
  } as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(tab);
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL) =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/browser-download/report.txt",
          expiresAt: Date.now() + 60_000,
          delivery: "attachment",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);

  await runExternalDocumentAction(
    { kind: "hostFile", path: "/tmp/report.txt" },
    "download",
  );

  expect(open).toHaveBeenCalledWith("", "_blank");
  expect(tab.opener).toBeNull();
  expect(replace).toHaveBeenCalledWith(
    `${serverHttpOrigin()}/api/file-grants/browser-download/report.txt`,
  );
  expect(String(replace.mock.calls[0]?.[0])).not.toContain("token=");
  expect(requestBodyOf(fetchSpy)).toMatchObject({
    scope: "file",
    delivery: "attachment",
  });
});

it("fails closed when an old shell rejects the narrow opener command", async () => {
  document.documentElement.setAttribute("data-native-shell", "macos");
  const invoke = vi.fn(async () => {
    throw new Error("unknown command open_served_file");
  });
  window.__TAURI__ = { core: { invoke } };
  const open = vi.spyOn(window, "open");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "/api/file-grants/download-1/report.txt",
            expiresAt: Date.now() + 60_000,
            delivery: "attachment",
          }),
          { status: 200 },
        ),
    ),
  );

  await runExternalDocumentAction(
    { kind: "hostFile", path: "/tmp/report.txt" },
    "download",
  );
  expect(invoke).toHaveBeenCalledOnce();
  expect(open).not.toHaveBeenCalled();
});

it("opens every non-host typed source through a grant in Tauri", async () => {
  document.documentElement.setAttribute("data-native-shell", "ios");
  const invoke = vi.fn();
  window.__TAURI__ = { core: { invoke } };
  const targets = [
    { kind: "sessionArtifact" as const, sessionId: "s1", path: "report.pdf" },
    { kind: "knowledgeFile" as const, path: "loose/report.pdf" },
    {
      kind: "knowledgeAsset" as const,
      entryId: "kb-1",
      path: "assets/report.pdf",
    },
    {
      kind: "worktreeFile" as const,
      worktreeId: "w1",
      path: "report.pdf",
      view: "file" as const,
    },
  ];
  const fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/source-1/report.pdf",
          expiresAt: Date.now() + 60_000,
          delivery: "inline",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  for (const target of targets) {
    expect(externalDocumentActionEnabled(target)).toBe(true);
    await runExternalDocumentAction(target, "open");
  }
  expect(fetchSpy).toHaveBeenCalledTimes(4);
  expect(
    fetchSpy.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [unknown, RequestInit])[1].body)),
    ),
  ).toEqual(
    targets.map((target) => ({
      target,
      scope: "file",
      delivery: "inline",
    })),
  );
  expect(invoke).toHaveBeenCalledTimes(4);
  expect(invoke).toHaveBeenLastCalledWith("open_served_file", {
    url: `${serverHttpOrigin()}/api/file-grants/source-1/report.pdf`,
  });
});
