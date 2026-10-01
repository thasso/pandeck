import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TempoToolConfig } from "../../tempoSettings.ts";

vi.mock("../../tempoSettings.ts", async (importActual) => ({
  ...(await importActual<typeof import("../../tempoSettings.ts")>()),
  getTempoToolConfig: vi.fn(),
}));

const { getTempoToolConfig } = await import("../../tempoSettings.ts");
const { tempoExportWorklogsTool, tempoExportReportTool } =
  await import("./tempoExportTools.ts");
const { EXPORTS_DIR } = await import("./tempoExportStore.ts");
const { setRetrySleepForTests } = await import("../../httpRetry.ts");

const jira = {
  jiraHost: "example.atlassian.net",
  atlassianEmail: "a@b.c",
  atlassianToken: "t",
};

function setConfig(jiraConfig: TempoToolConfig["jira"]): void {
  vi.mocked(getTempoToolConfig).mockResolvedValue({
    apiBaseUrl: "https://api.tempo.io/4",
    accessToken: "at",
    authorAccountId: "",
    jira: jiraConfig,
  });
}

type Worklog = {
  tempoWorklogId: number;
  issue: { id: string };
  timeSpentSeconds: number;
  startDate: string;
  author: { accountId: string };
  description: string;
  attributes: { values: Array<{ key: string; value: string }> };
};

function worklog(
  id: number,
  date: string,
  issueId: string,
  seconds: number,
  author = "acc-1",
): Worklog {
  return {
    tempoWorklogId: id,
    issue: { id: issueId },
    timeSpentSeconds: seconds,
    startDate: date,
    author: { accountId: author },
    description: `work ${id}`,
    attributes: { values: [{ key: "_Account_", value: "DEV" }] },
  };
}

const issues: Record<string, Record<string, unknown>> = {
  "10001": {
    id: "10001",
    key: "WEB-1",
    fields: {
      summary: "Activation A",
      issuetype: { name: "Task" },
      status: { name: "Done" },
      project: { key: "WEB", name: "Web" },
      labels: ["activation", "approved"],
      customfield_10050: { value: "CC-100" },
    },
  },
  "10002": {
    id: "10002",
    key: "SDK-7",
    fields: {
      summary: "Activation B",
      issuetype: { name: "Story" },
      status: { name: "Open" },
      project: { key: "SDK", name: "SDK" },
      labels: ["review"],
      customfield_10050: { value: "CC-200" },
    },
  },
};

const originalFetch = globalThis.fetch;
const ctx = () => ({
  toolCallId: "call-1",
  session: { sessionId: "s1", harness: "pi", agentType: "assistant" },
});

/** One fake Tempo + Jira: Tempo answers by date window; Jira by bulkfetch/user bulk. */
function mockServices(
  all: Worklog[],
  options: { jira429Times?: number; tempoFailWindowFrom?: string } = {},
) {
  let jira429 = options.jira429Times ?? 0;
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.hostname === "api.tempo.io") {
      const from = url.searchParams.get("from")!;
      const to = url.searchParams.get("to")!;
      if (options.tempoFailWindowFrom === from)
        return new Response("boom", { status: 500 });
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const inRange = all.filter(
        (w) => w.startDate >= from && w.startDate <= to,
      );
      const results = inRange.slice(offset, offset + limit);
      return new Response(
        JSON.stringify({
          results,
          metadata: {
            next: offset + results.length < inRange.length ? "n" : undefined,
          },
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/issue/bulkfetch")) {
      if (jira429 > 0) {
        jira429 -= 1;
        return new Response("rate", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      const body = JSON.parse(String(init?.body)) as {
        issueIdsOrKeys: string[];
      };
      return new Response(
        JSON.stringify({
          issues: body.issueIdsOrKeys.map((id) => issues[id]).filter(Boolean),
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/user/bulk")) {
      return new Response(
        JSON.stringify({
          values: [
            { accountId: "acc-1", displayName: "Ada" },
            { accountId: "acc-2", displayName: "Bob" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.pathname.endsWith("/rest/api/3/field"))
      return new Response(
        JSON.stringify([
          {
            id: "customfield_10050",
            name: "Cost Center",
            custom: true,
          },
        ]),
        { status: 200 },
      );
    if (url.pathname.startsWith("/rest/api/3/project/"))
      return new Response(
        JSON.stringify({ id: "700", key: "WEB", name: "Web" }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return calls;
}

function payloadOf(result: {
  content: Array<{ type: string; text?: string }>;
}) {
  return JSON.parse(result.content[0]!.text ?? "{}");
}

beforeEach(() => {
  setRetrySleepForTests(async () => {});
  rmSync(EXPORTS_DIR, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRetrySleepForTests(null);
  vi.clearAllMocks();
});

const dataset = [
  worklog(1, "2024-12-30", "10001", 3600),
  worklog(2, "2025-01-02", "10001", 1800),
  worklog(3, "2025-01-09", "10002", 7200, "acc-2"),
  worklog(4, "2025-01-20", "10001", 600),
  worklog(5, "2025-02-01", "10001", 900),
];

describe("tempo_export_worklogs", () => {
  test("extracts every window, joins Jira, persists CSV/JSON with checksum and totals", async () => {
    setConfig(jira);
    const calls = mockServices(dataset);
    const result = await tempoExportWorklogsTool.execute(
      {
        from: "2025-01-01",
        to: "2025-01-31",
        windowDays: 10,
        jiraFields: ["customfield_10050"],
      },
      ctx() as never,
    );
    const payload = payloadOf(result);
    expect(payload.status).toBe("complete");
    expect(payload.rowCount).toBe(3);
    expect(payload.totalSeconds).toBe(1800 + 7200 + 600);
    expect(payload.issueCount).toBe(2);
    expect(payload.authorCount).toBe(2);
    expect(payload.jiraEnrichment).toBe("on");
    expect(payload.windows).toHaveLength(4);
    expect(payload.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.files.csv.url).toMatch(
      /^\/api\/files\/.*worklogs\.csv\?download=1$/,
    );
    expect(calls.filter((c) => c.startsWith("GET /4/worklogs"))).toHaveLength(
      4,
    );

    const csv = readFileSync(payload.files.csv.path, "utf8");
    const [header, ...lines] = csv.trim().split("\n");
    expect(header).toContain("Cost Center (customfield_10050)");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("WEB-1");
    expect(lines[0]).toContain("Ada");
    expect(lines[0]).toContain("CC-100");
    const json = JSON.parse(readFileSync(payload.files.json.path, "utf8"));
    expect(json[1]).toMatchObject({
      issueKey: "SDK-7",
      projectKey: "SDK",
      authorName: "Bob",
      activity: "DEV",
      labels: ["review"],
      issueUrl: "https://example.atlassian.net/browse/SDK-7",
    });
  });

  test("a failed window keeps the checkpoint and resumes without re-reading finished windows", async () => {
    setConfig(jira);
    mockServices(dataset, { tempoFailWindowFrom: "2025-01-11" });
    await expect(
      tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-31", windowDays: 10 },
        ctx() as never,
      ),
    ).rejects.toThrow(/resume/);
    const exportId = (await tempoExportReportTool.execute({}, ctx() as never))
      .details as { exports: Array<{ exportId: string; windowsDone: number }> };
    expect(exportId.exports[0]!.windowsDone).toBe(1);

    const calls = mockServices(dataset);
    const resumed = payloadOf(
      await tempoExportWorklogsTool.execute(
        { exportId: exportId.exports[0]!.exportId },
        ctx() as never,
      ),
    );
    expect(resumed.rowCount).toBe(3);
    expect(resumed.duplicatesRemoved).toBe(0);
    const windowCalls = calls.filter((c) => c.startsWith("GET /4/worklogs"));
    expect(windowCalls).toHaveLength(3);
  });

  test("a Jira 429 storm leaves a partial join that the next run completes from cache", async () => {
    setConfig(jira);
    mockServices(dataset, { jira429Times: 20 });
    const first = payloadOf(
      await tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-31" },
        ctx() as never,
      ),
    );
    expect(first.jiraEnrichment).toBe("partial");
    expect(first.rowCount).toBe(3);
    expect(first.notes.join(" ")).toMatch(/Jira join incomplete/);

    const calls = mockServices(dataset);
    const second = payloadOf(
      await tempoExportWorklogsTool.execute(
        { exportId: first.exportId },
        ctx() as never,
      ),
    );
    expect(second.jiraEnrichment).toBe("on");
    expect(calls.filter((c) => c.startsWith("GET /4/worklogs"))).toHaveLength(
      0,
    );
  });

  test("requested jiraFields survive a partial join and an exportId-only resume", async () => {
    setConfig(jira);
    mockServices(dataset, { jira429Times: 20 });
    const first = payloadOf(
      await tempoExportWorklogsTool.execute(
        {
          from: "2025-01-01",
          to: "2025-01-31",
          jiraFields: ["customfield_10050"],
        },
        ctx() as never,
      ),
    );
    expect(first.jiraEnrichment).toBe("partial");
    expect(first.extraFields).toEqual(["customfield_10050"]);

    mockServices(dataset);
    const resumed = payloadOf(
      await tempoExportWorklogsTool.execute(
        { exportId: first.exportId },
        ctx() as never,
      ),
    );
    expect(resumed.jiraEnrichment).toBe("on");
    expect(resumed.extraFields).toEqual(["customfield_10050"]);
    const header = readFileSync(resumed.files.csv.path, "utf8").split("\n")[0];
    expect(header).toContain("customfield_10050");
    const json = JSON.parse(readFileSync(resumed.files.json.path, "utf8"));
    expect(json[0].fields).toEqual({ customfield_10050: "CC-100" });
  });

  test("two exports of the same range in one second get distinct folders", async () => {
    setConfig(jira);
    mockServices(dataset);
    const args = {
      from: "2025-01-01",
      to: "2025-01-05",
      jiraEnrichment: false,
    };
    const a = payloadOf(
      await tempoExportWorklogsTool.execute(args, ctx() as never),
    );
    const b = payloadOf(
      await tempoExportWorklogsTool.execute(args, ctx() as never),
    );
    expect(a.exportId).not.toBe(b.exportId);
    expect(b.rowCount).toBe(1);
    expect(b.duplicatesRemoved).toBe(0);
  });

  test("jiraEnrichment=false never calls Jira and keeps raw issue ids", async () => {
    setConfig(jira);
    const calls = mockServices(dataset);
    const payload = payloadOf(
      await tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-31", jiraEnrichment: false },
        ctx() as never,
      ),
    );
    expect(payload.jiraEnrichment).toBe("off");
    expect(calls.some((c) => c.includes("/rest/api/"))).toBe(false);
    const json = JSON.parse(readFileSync(payload.files.json.path, "utf8"));
    expect(json[0]).toMatchObject({ issueId: "10001", issueKey: null });
  });

  test("project keys resolve to ids and route through Tempo search", async () => {
    setConfig(jira);
    const calls = mockServices(dataset);
    const payload = payloadOf(
      await tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-05", projectKeys: ["WEB"] },
        ctx() as never,
      ),
    );
    expect(payload.projectKeys).toEqual(["WEB"]);
    expect(calls).toContain("GET /rest/api/3/project/WEB");
    expect(calls.some((c) => c === "POST /4/worklogs/search")).toBe(true);
  });

  test("jiraEnrichment=false refuses symbolic filters and skips field labels", async () => {
    setConfig(jira);
    const calls = mockServices(dataset);
    await expect(
      tempoExportWorklogsTool.execute(
        {
          from: "2025-01-01",
          to: "2025-01-05",
          projectKeys: ["WEB"],
          jiraEnrichment: false,
        },
        ctx() as never,
      ),
    ).rejects.toThrow(/leave jiraEnrichment on/);
    const payload = payloadOf(
      await tempoExportWorklogsTool.execute(
        {
          from: "2025-01-01",
          to: "2025-01-05",
          projectKeys: ["700"],
          jiraFields: ["customfield_10050"],
          jiraEnrichment: false,
        },
        ctx() as never,
      ),
    );
    expect(payload.jiraEnrichment).toBe("off");
    expect(calls.some((c) => c.includes("/rest/api/"))).toBe(false);
    expect(calls).toContain("POST /4/worklogs/search");
  });

  test("symbolic project keys without Jira are refused", async () => {
    setConfig(null);
    mockServices(dataset);
    await expect(
      tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-05", projectKeys: ["WEB"] },
        ctx() as never,
      ),
    ).rejects.toThrow(/needs the Jira integration/);
    expect(existsSync(EXPORTS_DIR)).toBe(false);
  });
});

describe("tempo_export_report", () => {
  test("aggregates a finished export by dimensions with date/issue/label filters", async () => {
    setConfig(jira);
    mockServices([...dataset, worklog(6, "2025-01-15", "10001", 300)]);
    const exported = payloadOf(
      await tempoExportWorklogsTool.execute(
        { from: "2024-12-01", to: "2025-02-28", windowDays: 31 },
        ctx() as never,
      ),
    );
    expect(exported.rowCount).toBe(6);

    const dated = payloadOf(
      await tempoExportReportTool.execute(
        {
          exportId: exported.exportId,
          from: "2025-01-01",
          to: "2025-12-31",
          issueKeys: ["WEB-1"],
          groupBy: ["issue"],
        },
        ctx() as never,
      ),
    );
    expect(dated.worklogCount).toBe(4);
    expect(dated.totalSeconds).toBe(1800 + 600 + 900 + 300);
    expect(dated.rows[0]).toMatchObject({ issueKey: "WEB-1", count: 4 });

    const byCostCenter = payloadOf(
      await tempoExportReportTool.execute(
        {
          exportId: exported.exportId,
          groupBy: ["customfield_10050", "author"],
          jiraFields: ["customfield_10050"],
          persist: true,
        },
        ctx() as never,
      ),
    );
    expect(byCostCenter.rows).toHaveLength(2);
    expect(byCostCenter.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          customfield_10050: "CC-200",
          authorName: "Bob",
          seconds: 7200,
        }),
        expect.objectContaining({
          customfield_10050: "CC-100",
          authorName: "Ada",
          seconds: 7200,
        }),
      ]),
    );
    expect(byCostCenter.reportCsv.url).toMatch(/report-.*\.csv\?download=1$/);
    expect(readFileSync(byCostCenter.reportCsv.path, "utf8")).toContain(
      "CC-200",
    );

    const approved = payloadOf(
      await tempoExportReportTool.execute(
        {
          exportId: exported.exportId,
          labels: ["approved"],
          groupBy: ["project"],
        },
        ctx() as never,
      ),
    );
    expect(approved.rows).toEqual([
      expect.objectContaining({ projectKey: "WEB", seconds: 7200 }),
    ]);
    const excluded = payloadOf(
      await tempoExportReportTool.execute(
        { exportId: exported.exportId, excludeLabels: ["approved", "review"] },
        ctx() as never,
      ),
    );
    expect(excluded.worklogCount).toBe(0);
  });

  test("refuses an unfinished export and unknown groupBy", async () => {
    setConfig(jira);
    mockServices(dataset, { tempoFailWindowFrom: "2025-01-01" });
    await expect(
      tempoExportWorklogsTool.execute(
        { from: "2025-01-01", to: "2025-01-05" },
        ctx() as never,
      ),
    ).rejects.toThrow();
    const listed = payloadOf(
      await tempoExportReportTool.execute({}, ctx() as never),
    );
    await expect(
      tempoExportReportTool.execute(
        { exportId: listed.exports[0].exportId },
        ctx() as never,
      ),
    ).rejects.toThrow(/extracting/);

    mockServices(dataset);
    const finished = payloadOf(
      await tempoExportWorklogsTool.execute(
        { exportId: listed.exports[0].exportId },
        ctx() as never,
      ),
    );
    await expect(
      tempoExportReportTool.execute(
        { exportId: finished.exportId, groupBy: ["nope"] },
        ctx() as never,
      ),
    ).rejects.toThrow(/Unknown groupBy/);
  });
});
