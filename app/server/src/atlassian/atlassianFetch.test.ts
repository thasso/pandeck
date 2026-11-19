import { afterEach, describe, expect, test, vi } from "vitest";
import { FAKE_ACCESS } from "../test/atlassianFake.ts";
import {
  AtlassianHttpError,
  atlassianDownload,
  atlassianFetch,
} from "./atlassianFetch.ts";

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

describe("AtlassianHttpError reasons (Task-1439 D4)", () => {
  async function failure(body: string, status = 400) {
    stubFetch(() => new Response(body, { status }));
    try {
      await atlassianFetch(
        CONFIG,
        "Jira",
        "POST",
        "/rest/api/3/search/jql",
        {},
      );
    } catch (err) {
      expect(err).toBeInstanceOf(AtlassianHttpError);
      return err as AtlassianHttpError;
    }
    throw new Error("expected a failure");
  }

  test("errorMessages strings, then errors string values, field names dropped", async () => {
    const body = JSON.stringify({
      errorMessages: ["first", "second"],
      errors: { jql: "third", project: "fourth" },
      other: "never",
    });
    const err = await failure(body);
    expect(err.reasons).toEqual(["first", "second", "third", "fourth"]);
    expect(err.status).toBe(400);
    expect(err.message).toBe(
      `Jira API returned HTTP 400 for POST /rest/api/3/search/jql: ${body}`,
    );
  });

  test("malformed containers and non-string entries are skipped", async () => {
    expect(
      (
        await failure(
          JSON.stringify({
            errorMessages: ["ok", 5, null, { a: "b" }],
            errors: { n: 1, o: { p: "q" }, s: "fine" },
          }),
        )
      ).reasons,
    ).toEqual(["ok", "fine"]);
    expect(
      (await failure(JSON.stringify({ errorMessages: "x", errors: ["y"] })))
        .reasons,
    ).toBeUndefined();
  });

  test("a body that is not a JSON object, or holds no reason, gives none", async () => {
    for (const body of ["<html>x</html>", "", '["x"]', '"x"', "{}"])
      expect((await failure(body, 500)).reasons, body).toBeUndefined();
  });

  test("the reasons come from the whole body, past the message's 400 characters", async () => {
    const long = "z".repeat(1000);
    const err = await failure(JSON.stringify({ errorMessages: [long] }));
    expect(err.reasons).toEqual([long]);
    expect(err.message.length).toBeLessThan(600);
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

// --- Bearer (Task-1411): the destination is fixed, never the site ----------

const CLOUD_ID = "00000000-0000-4000-8000-00000000fa4e";
const FAKE_ACCESS_BEARER = FAKE_ACCESS;
const BEARER = {
  host: "castlabs-test.atlassian.net",
  cloudId: CLOUD_ID,
  bearerToken: FAKE_ACCESS_BEARER,
};

describe("atlassianFetch with a Bearer config", () => {
  test("Jira goes to the fixed Jira base for the cloud id, with Bearer", async () => {
    const fetchMock = stubFetch(() => Response.json({ accountId: "a" }));
    await atlassianFetch(
      BEARER,
      "Jira",
      "GET",
      "/rest/api/3/myself",
      undefined,
      {
        expand: "groups",
      },
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself?expand=groups`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_ACCESS_BEARER}`,
    });
  });

  test("Confluence content goes to the fixed Confluence base", async () => {
    const fetchMock = stubFetch(() => Response.json({ id: "1" }));
    await atlassianFetch(
      BEARER,
      "Confluence",
      "GET",
      "/wiki/rest/api/content/1",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/rest/api/content/1`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_ACCESS_BEARER}`,
    });
  });

  test("a hostile site still reaches only api.atlassian.com", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    await atlassianFetch(
      { ...BEARER, host: "https://evil.example" },
      "Jira",
      "GET",
      "/rest/api/3/myself",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/myself`,
    );
  });

  test("absolute, scheme-relative, relative and escaping paths are refused before any request", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    for (const path of [
      "https://evil.example/x",
      "http://api.atlassian.com/ex/jira/x",
      "//evil.example/x",
      "rest/api/3/myself",
      "/../../confluence/x",
      "/%2e%2e/%2e%2e/confluence/x",
      "/..",
      "/\\evil.example/x",
    ])
      await expect(
        atlassianFetch(BEARER, "Jira", "GET", path),
        path,
      ).rejects.toThrow(/site-relative/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a cloud id that is not a UUID, or no token, is refused before any request", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    for (const cloudId of [
      "x",
      `${CLOUD_ID}/..`,
      "../jira",
      CLOUD_ID.toUpperCase(),
    ])
      await expect(
        atlassianFetch({ ...BEARER, cloudId }, "Jira", "GET", "/rest/api/3/x"),
        cloudId,
      ).rejects.toThrow(/cloud id/);
    await expect(
      atlassianFetch({ ...BEARER, bearerToken: "" }, "Jira", "GET", "/x"),
    ).rejects.toThrow(/access token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the Basic member keeps taking an absolute URL as the whole URL", async () => {
    const fetchMock = stubFetch(() => Response.json({}));
    await atlassianFetch(
      CONFIG,
      "Jira",
      "GET",
      "https://example.atlassian.net/rest/api/3/search?jql=x",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://example.atlassian.net/rest/api/3/search?jql=x",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from("a@b.c:t").toString("base64")}`,
    });
  });
});

describe("atlassianDownload with a Bearer config", () => {
  test("an attachment comes from the fixed Confluence base, with Bearer", async () => {
    const fetchMock = stubFetch(() => new Response("png"));
    const result = await atlassianDownload(
      BEARER,
      "Confluence",
      "/wiki/download/attachments/1/a.png",
      10,
    );
    expect(new TextDecoder().decode(result.bytes)).toBe("png");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/download/attachments/1/a.png`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      method: "GET",
      headers: { Authorization: `Bearer ${FAKE_ACCESS_BEARER}` },
    });
  });

  test("never sends the access token off the API base", async () => {
    const fetchMock = stubFetch(() => new Response("x"));
    for (const path of [
      "https://evil.example/x",
      "//evil.example/x",
      "x",
      "/../../jira/x",
    ])
      await expect(
        atlassianDownload(BEARER, "Confluence", path, 10),
        path,
      ).rejects.toThrow(/site-relative/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
