import { afterEach, describe, expect, test, vi } from "vitest";
import {
  confluenceDelete,
  confluencePut,
  confluenceWebUrl,
} from "./confluenceClient.ts";

const HOST = "example.atlassian.net";

describe("confluenceWebUrl", () => {
  test("resolves a wiki-relative path against /wiki", () => {
    expect(confluenceWebUrl(HOST, "/spaces/ENG/pages/123/Runbook")).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
    );
  });

  test("does not prefix /wiki twice when the path already names it", () => {
    expect(confluenceWebUrl(HOST, "/wiki/spaces/ENG/pages/123/Runbook")).toBe(
      "https://example.atlassian.net/wiki/spaces/ENG/pages/123/Runbook",
    );
  });

  test("passes an absolute URL through and answers null for nothing", () => {
    expect(confluenceWebUrl(HOST, "https://other.test/x")).toBe(
      "https://other.test/x",
    );
    expect(confluenceWebUrl(HOST, undefined)).toBeNull();
    expect(confluenceWebUrl(HOST, "")).toBeNull();
  });
});

describe("confluencePut and confluenceDelete over the real transport", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("options.signal reaches fetch; without options no signal does", async () => {
    const seen: Array<{ method: string; signal: AbortSignal | undefined }> = [];
    globalThis.fetch = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? "GET",
        signal: init?.signal ?? undefined,
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const config = { host: HOST, atlassianEmail: "a@b.c", atlassianToken: "t" };
    const { signal } = new AbortController();
    await confluencePut(config, "/wiki/api/v2/pages/1", {}, undefined, {
      signal,
    });
    await confluenceDelete(config, "/wiki/api/v2/pages/1", undefined, {
      signal,
    });
    await confluencePut(config, "/wiki/api/v2/pages/1", {});
    await confluenceDelete(config, "/wiki/api/v2/pages/1");
    expect(seen).toEqual([
      { method: "PUT", signal },
      { method: "DELETE", signal },
      { method: "PUT", signal: undefined },
      { method: "DELETE", signal: undefined },
    ]);
  });
});
