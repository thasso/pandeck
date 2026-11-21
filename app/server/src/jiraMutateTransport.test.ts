/**
 * The shared Jira mutation core (Task-1463) over the REAL transport: real
 * `jiraClient.ts` → `atlassianFetch` → `fetchWithRetry`, with only the global
 * `fetch` faked, as in `jiraClient.test.ts`. These tests see what reaches the
 * network: `init.signal` and how many requests are made.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { JiraIssueMutationItemDisplay } from "@assistant/shared/jiraMutation";
import { AtlassianHttpError } from "./atlassian/atlassianFetch.ts";
import { errorText } from "./errors.ts";
import { setRetrySleepForTests } from "./httpRetry.ts";
import { jiraDelete, jiraPut, type JiraConfig } from "./jiraClient.ts";
import { buildJiraMutationItems } from "./jiraMutate.ts";
import { applyJiraMutationItems } from "./jiraMutateApply.ts";
import { JiraMutationError, JiraWriteHttpError } from "./jiraMutationErrors.ts";

const config: JiraConfig = {
  jiraHost: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};
const originalFetch = globalThis.fetch;

type Seen = { method: string; path: string; signal: AbortSignal | undefined };

/** Fakes `fetch`, recording each request; `answer` decides the response. */
function fakeFetch(
  answer: (request: Seen) => Response | Promise<Response>,
): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const request: Seen = {
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      signal: init?.signal ?? undefined,
    };
    seen.push(request);
    return answer(request);
  }) as unknown as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** What fetch does when its signal aborts mid-request. */
const abortedFetch = () =>
  new DOMException("This operation was aborted", "AbortError");

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
});

describe("jiraPut and jiraDelete call options (AC5a)", () => {
  test("options.signal reaches fetch; without options the request is as before", async () => {
    const seen = fakeFetch(() => json({}));
    const { signal } = new AbortController();
    await jiraPut(
      config,
      "/rest/api/3/issue/NEB-1",
      { fields: {} },
      undefined,
      {
        signal,
      },
    );
    await jiraDelete(config, "/rest/api/3/issueLink/9001", undefined, {
      signal,
    });
    await jiraPut(config, "/rest/api/3/issue/NEB-1", { fields: {} });
    await jiraDelete(config, "/rest/api/3/issueLink/9001");
    expect(seen).toEqual([
      { method: "PUT", path: "/rest/api/3/issue/NEB-1", signal },
      { method: "DELETE", path: "/rest/api/3/issueLink/9001", signal },
      { method: "PUT", path: "/rest/api/3/issue/NEB-1", signal: undefined },
      {
        method: "DELETE",
        path: "/rest/api/3/issueLink/9001",
        signal: undefined,
      },
    ]);
  });

  test("a write still makes one attempt, with or without options", async () => {
    setRetrySleepForTests(async () => {});
    const seen = fakeFetch(() => new Response("busy", { status: 503 }));
    await expect(
      jiraPut(config, "/rest/api/3/issue/NEB-1", {}, undefined, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/HTTP 503/);
    await expect(jiraDelete(config, "/rest/api/3/issueLink/1")).rejects.toThrow(
      /HTTP 503/,
    );
    expect(seen).toHaveLength(2);
  });

  test("an already aborted signal sends nothing", async () => {
    const seen = fakeFetch(() => json({}));
    const controller = new AbortController();
    controller.abort();
    await expect(
      jiraDelete(config, "/rest/api/3/issueLink/1", undefined, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(0);
  });
});

const linkAdd = (target: string) => ({
  op: "add" as const,
  type: "Blocks",
  direction: "outward" as const,
  relationship: "blocks",
  targetIssueKey: target,
});

function linkItem(): JiraIssueMutationItemDisplay {
  return {
    clientId: "item-1",
    issueKey: "NEB-1",
    operation: "edit",
    issueUrl: "https://example.atlassian.net/browse/NEB-1",
    fieldChanges: [],
    linkChanges: [
      linkAdd("NEB-2"),
      linkAdd("NEB-3"),
      {
        ...linkAdd("NEB-4"),
        op: "remove",
        relationship: "unlink",
        linkId: "9001",
      },
    ],
  };
}

describe("apply over the real transport (AC5b, O3, O4)", () => {
  test.each(["comment", "link"] as const)(
    "an aborted %s write propagates an AtlassianHttpError reason unchanged",
    async (operation) => {
      const controller = new AbortController();
      const reason = new AtlassianHttpError("caller abort reason", 404);
      const seen = fakeFetch(() => {
        controller.abort(reason);
        throw reason;
      });
      const item: JiraIssueMutationItemDisplay =
        operation === "comment"
          ? {
              clientId: "item-1",
              issueKey: "NEB-1",
              operation: "comment",
              commentBody: "Hi",
              fieldChanges: [],
            }
          : linkItem();
      await expect(
        applyJiraMutationItems(config, [item], {
          signal: controller.signal,
          fieldMap: async () => ({
            fetchedAt: 1,
            byId: new Map(),
            byNameLower: new Map(),
          }),
          describeError: errorText,
        }),
      ).rejects.toBe(reason);
      expect(seen).toHaveLength(1);
      expect(item.error).toBeUndefined();
      if (operation === "link")
        expect(item.linkChanges![0]!.error).toBeUndefined();
    },
  );

  test("an abort during the first link POST stops the sequence at one request", async () => {
    const controller = new AbortController();
    const thrown = abortedFetch();
    const seen = fakeFetch(() => {
      controller.abort();
      throw thrown;
    });
    const item = linkItem();
    await expect(
      applyJiraMutationItems(config, [item], {
        signal: controller.signal,
        fieldMap: async () => ({
          fetchedAt: 1,
          byId: new Map(),
          byNameLower: new Map(),
        }),
        describeError: errorText,
      }),
    ).rejects.toBe(thrown);
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/rest/api/3/issueLink",
        signal: controller.signal,
      },
    ]);
    expect(item.linkChanges![0]!.error).toBeUndefined();
    expect(item.error).toBeUndefined();
  });

  test("an abort is recognised by the signal even when the request completed", async () => {
    // fetch ignores the abort and answers; the next request is refused by the
    // transport's own pre-check with ITS AbortError, which is still propagated.
    const controller = new AbortController();
    const seen = fakeFetch(() => {
      controller.abort(new Error("caller gave up"));
      return json({});
    });
    const item = linkItem();
    await expect(
      applyJiraMutationItems(config, [item], {
        signal: controller.signal,
        fieldMap: async () => ({
          fetchedAt: 1,
          byId: new Map(),
          byNameLower: new Map(),
        }),
        describeError: errorText,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
    expect(item.linkChanges![0]!.resultOk).toBe(true);
    expect(item.linkChanges![1]!.error).toBeUndefined();
    expect(item.error).toBeUndefined();
  });

  test("an abort during a rank PUT sends no later step and no observation", async () => {
    const controller = new AbortController();
    const thrown = abortedFetch();
    const seen = fakeFetch(() => {
      controller.abort();
      throw thrown;
    });
    const item: JiraIssueMutationItemDisplay = {
      clientId: "item-1",
      issueKey: "NEB-2",
      operation: "rank",
      fieldChanges: [],
      rankIssueKeys: ["NEB-2", "NEB-3"],
      rankPosition: "before",
      rankTargetIssueKey: "NEB-9",
      rankSteps: [
        { issueKey: "NEB-2", placement: "before", relativeToIssueKey: "NEB-9" },
        { issueKey: "NEB-3", placement: "after", relativeToIssueKey: "NEB-2" },
      ],
    };
    await expect(
      applyJiraMutationItems(config, [item], {
        signal: controller.signal,
        fieldMap: async () => ({
          fetchedAt: 1,
          byId: new Map(),
          byNameLower: new Map(),
        }),
        describeError: errorText,
      }),
    ).rejects.toBe(thrown);
    expect(seen).toEqual([
      {
        method: "PUT",
        path: "/rest/agile/1.0/issue/rank",
        signal: controller.signal,
      },
    ]);
    expect(item.rankSteps![0]!.error).toBeUndefined();
  });

  test("a rejected write carries Jira's status and reasons as JiraWriteHttpError", async () => {
    fakeFetch(() =>
      json({ errorMessages: ["Field 'summary' cannot be set."] }, 400),
    );
    const seen: unknown[] = [];
    const item: JiraIssueMutationItemDisplay = {
      clientId: "item-1",
      issueKey: "NEB-1",
      operation: "edit",
      fieldChanges: [
        {
          fieldId: "summary",
          label: "Summary",
          to: "New",
          operation: "set",
          value: "New",
        },
      ],
    };
    await expect(
      applyJiraMutationItems(config, [item], {
        fieldMap: async () => ({
          fetchedAt: 1,
          byId: new Map(),
          byNameLower: new Map(),
        }),
        describeError: (err) => {
          seen.push(err);
          return errorText(err);
        },
      }),
    ).rejects.toBeInstanceOf(JiraMutationError);
    expect(item.error).toBe(
      'Jira API returned HTTP 400 for PUT /rest/api/3/issue/NEB-1: {"errorMessages":["Field \'summary\' cannot be set."]}',
    );
    expect(seen[0]).toBeInstanceOf(JiraWriteHttpError);
    expect(seen[0]).toMatchObject({
      status: 400,
      reasons: ["Field 'summary' cannot be set."],
    });
  });
});

describe("prepare over the real transport (AC5c)", () => {
  test("a prepare read carries the signal to fetch", async () => {
    const seen = fakeFetch(() =>
      json({ permissions: { ADD_COMMENTS: { havePermission: true } } }),
    );
    const { signal } = new AbortController();
    await buildJiraMutationItems(
      config,
      [{ operation: "comment", issue: "NEB-1", commentBody: "Hi" }],
      {
        signal,
        fieldMap: async () => ({
          fetchedAt: 1,
          byId: new Map(),
          byNameLower: new Map(),
        }),
        issueLinkTypes: async () => [],
        describeError: errorText,
        matchesHttpStatus: () => false,
      },
    );
    expect(seen).toEqual([
      { method: "GET", path: "/rest/api/3/mypermissions", signal },
    ]);
  });
});
