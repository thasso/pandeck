import { afterEach, describe, expect, test, vi } from "vitest";
import { atlassianDownload, atlassianFetch } from "./atlassianFetch.ts";

const CONFIG = {
  host: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};

function stubFetch(response: () => Response) {
  const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atlassianFetch", () => {
  test("a FormData body goes out as multipart with the XSRF opt-out", async () => {
    const fetchMock = stubFetch(() => Response.json({ results: [] }));
    const form = new FormData();
    form.append("file", new Blob(["x"]), "x.txt");
    await atlassianFetch(
      CONFIG,
      "Confluence",
      "POST",
      "/wiki/rest/api/content/1/child/attachment",
      form,
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe(form);
    expect(init?.headers).toMatchObject({ "X-Atlassian-Token": "no-check" });
    // fetch has to write the boundary itself.
    expect(init?.headers).not.toHaveProperty("Content-Type");
  });

  test("a JSON body is still serialized", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    await atlassianFetch(CONFIG, "Jira", "POST", "/rest/api/3/x", { a: 1 });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBe('{"a":1}');
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
  });
});

describe("atlassianDownload", () => {
  test("returns the bytes of a site-relative path", async () => {
    const fetchMock = stubFetch(
      () => new Response("abc", { headers: { "content-type": "text/plain" } }),
    );
    const result = await atlassianDownload(
      CONFIG,
      "Confluence",
      "/wiki/download/attachments/1/a.txt",
      10,
    );
    expect(new TextDecoder().decode(result.bytes)).toBe("abc");
    expect(result.contentType).toBe("text/plain");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://example.atlassian.net/wiki/download/attachments/1/a.txt",
    );
  });

  test("refuses a body past maxBytes instead of truncating it", async () => {
    stubFetch(() => new Response("abcdef"));
    await expect(
      atlassianDownload(CONFIG, "Confluence", "/wiki/download/x", 3),
    ).rejects.toThrow(/exceeds the 3-byte limit/);
  });

  test("never sends the credential off the site", async () => {
    const fetchMock = stubFetch(() => new Response("x"));
    for (const path of ["https://evil.test/x", "//evil.test/x", "x"])
      await expect(
        atlassianDownload(CONFIG, "Confluence", path, 10),
      ).rejects.toThrow(/site-relative/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
