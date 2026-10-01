import { afterEach, describe, expect, test, vi } from "vitest";
import type { TempoToolConfig } from "../../tempoSettings.ts";

// Override only getTempoToolConfig; keep resolveTempoAuthorAccountId and everything else real.
vi.mock("../../tempoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../tempoSettings.ts")>()),
  getTempoToolConfig: vi.fn(),
}));

const { getTempoToolConfig } = await import("../../tempoSettings.ts");
const { tempoListWorklogsTool, tempoMutateWorklogsTool } =
  await import("./tempoTools.ts");
const { approvalsForSession, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

setApprovalBroadcastForTests(() => {});

function payloadOf(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  return JSON.parse(
    result.content[0]!.type === "text"
      ? (result.content[0]!.text ?? "{}")
      : "{}",
  );
}

const originalFetch = globalThis.fetch;
const mockedGetConfig = vi.mocked(getTempoToolConfig);

function setConfig(jira: TempoToolConfig["jira"]): void {
  mockedGetConfig.mockResolvedValue({
    apiBaseUrl: "https://api.tempo.io/4",
    accessToken: "at",
    authorAccountId: "",
    jira,
  });
}

function worklogPage() {
  return new Response(
    JSON.stringify({
      results: [
        {
          tempoWorklogId: 1,
          issue: { id: "10001", key: "OPS-1", summary: "Echoed by Tempo" },
          timeSpentSeconds: 3600,
          startDate: "2026-07-13",
        },
      ],
      metadata: {},
    }),
    { status: 200 },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe("tempo_list_worklogs Jira-off degrade", () => {
  test("returns raw issue ids only (no key/summary/url) when Jira is unavailable", async () => {
    setConfig(null);
    globalThis.fetch = vi.fn(async () =>
      worklogPage(),
    ) as unknown as typeof fetch;

    const result = await tempoListWorklogsTool.execute(
      { from: "2026-07-13" } as never,
      {} as never,
    );
    const payload = JSON.parse(
      result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
    );

    expect(payload.jiraEnrichment).toBe("off");
    expect(payload.jiraHost).toBeNull();
    const wl = payload.worklogs[0];
    expect(wl.issue.id).toBe("10001"); // raw id retained
    expect(wl.issue.key).toBeNull(); // Tempo-echoed key suppressed
    expect(wl.issue.summary).toBeNull();
    expect(wl.issue.issueUrl).toBeNull();
  });
});

describe("tempo_list_worklogs paging and compact output", () => {
  const jira = {
    jiraHost: "example.atlassian.net",
    atlassianEmail: "a@b.c",
    atlassianToken: "t",
  };
  function tempoWithThree(calls: string[]) {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.hostname === "api.tempo.io") {
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        const all = [1, 2, 3].map((id) => ({
          tempoWorklogId: id,
          issue: { id: id === 3 ? "10002" : "10001" },
          timeSpentSeconds: 600 * id,
          startDate: "2026-07-13",
          author: { accountId: "me" },
        }));
        const results = all.slice(offset, offset + limit);
        return new Response(
          JSON.stringify({
            results,
            metadata: {
              next: offset + results.length < all.length ? "n" : undefined,
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.includes("/rest/api/3/issue/"))
        return new Response(
          JSON.stringify({
            id: url.pathname.endsWith("10002") ? "10002" : "10001",
            key: url.pathname.endsWith("10002") ? "OPS-2" : "OPS-1",
            fields: { summary: "S", project: { key: "OPS" } },
          }),
          { status: 200 },
        );
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
  }

  test("returns nextOffset when the page is full and continues from it", async () => {
    setConfig(null);
    tempoWithThree([]);
    const first = payloadOf(
      await tempoListWorklogsTool.execute(
        {
          from: "2026-07-13",
          includeAllAuthors: true,
          maxResults: 2,
        } as never,
        {} as never,
      ),
    );
    expect(first.worklogCount).toBe(2);
    expect(first.nextOffset).toBe(2);
    expect(first.exhausted).toBe(false);
    expect(first.notes.join(" ")).toMatch(/offset=2/);
    const second = payloadOf(
      await tempoListWorklogsTool.execute(
        {
          from: "2026-07-13",
          includeAllAuthors: true,
          maxResults: 2,
          offset: 2,
        } as never,
        {} as never,
      ),
    );
    expect(second.worklogs.map((w: { id: number }) => w.id)).toEqual([3]);
    expect(second.nextOffset).toBeNull();
    expect(second.exhausted).toBe(true);
  });

  test("output=totals groups without returning worklogs", async () => {
    setConfig(jira);
    tempoWithThree([]);
    const payload = payloadOf(
      await tempoListWorklogsTool.execute(
        {
          from: "2026-07-13",
          includeAllAuthors: true,
          output: "totals",
          groupBy: ["project", "issue"],
        } as never,
        {} as never,
      ),
    );
    expect(payload.worklogs).toBeUndefined();
    expect(payload.totalSeconds).toBe(3600);
    expect(payload.totals).toEqual([
      expect.objectContaining({
        projectKey: "OPS",
        issueKey: "OPS-1",
        seconds: 1800,
        count: 2,
      }),
      expect.objectContaining({
        projectKey: "OPS",
        issueKey: "OPS-2",
        seconds: 1800,
        count: 1,
      }),
    ]);
  });

  test("jiraEnrichment=false skips Jira even when it is configured", async () => {
    setConfig(jira);
    const calls: string[] = [];
    tempoWithThree(calls);
    const payload = payloadOf(
      await tempoListWorklogsTool.execute(
        {
          from: "2026-07-13",
          includeAllAuthors: true,
          jiraEnrichment: false,
        } as never,
        {} as never,
      ),
    );
    expect(payload.jiraEnrichment).toBe("off");
    expect(payload.worklogs[0].issue.key).toBeNull();
    expect(calls.some((c) => c.includes("/rest/api/"))).toBe(false);
  });
});

describe("tempo_mutate_worklogs hard Jira requirement", () => {
  test("throws when Jira is unavailable, regardless of session context", async () => {
    setConfig(null);
    const ctx = {
      session: { sessionManager: { appendCustomEntry: () => "entry-1" } },
    };
    await expect(
      tempoMutateWorklogsTool.execute(
        {
          items: [
            {
              action: "create",
              issueKey: "OPS-1",
              date: "2026-07-13",
              startTime: "09:00",
              activityKey: "MEETING",
              description: "x",
            },
          ],
        } as never,
        ctx as never,
      ),
    ).rejects.toThrow(/requires the Jira integration/i);
  });
});

describe("tempo_mutate_worklogs create staging → day plan", () => {
  test("assigns each create row a unique day-plan row id (travels as Tempo clientId)", async () => {
    setConfig({
      jiraHost: "example.atlassian.net",
      atlassianEmail: "a@b.c",
      atlassianToken: "t",
    });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/accounts"))
        return new Response(JSON.stringify({ results: [], metadata: {} }), {
          status: 200,
        });
      if (url.includes("/myself"))
        return new Response(JSON.stringify({ accountId: "me" }), {
          status: 200,
        });
      if (url.includes("/editmeta"))
        return new Response(
          JSON.stringify({
            fields: { customfield_10800: { allowedValues: [] } },
          }),
          { status: 200 },
        );
      if (/\/rest\/api\/3\/issue\/[^/]+/.test(url))
        return new Response(
          JSON.stringify({ id: "10001", fields: { summary: "S" } }),
          { status: 200 },
        );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const sid = "tempo-stage-1";
    await tempoMutateWorklogsTool.execute(
      {
        items: [
          {
            action: "create",
            issueKey: "OPS-1",
            date: "2026-07-13",
            startTime: "09:00",
            timeSpentSeconds: 3600,
            activityKey: "MEETING",
            description: "Sync",
          },
        ],
      } as never,
      { session: { sessionId: sid } } as never,
    );
    const card = approvalsForSession(sid).at(-1)!;
    expect(card.body.kind).toBe("tempoWorklog");
    if (card.body.kind === "tempoWorklog") {
      expect(card.body.items[0]!.clientId).toMatch(
        /^tempo:2026-07-13:chat-[0-9a-f]{8}$/,
      );
    }
  });
});
