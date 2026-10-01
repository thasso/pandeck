import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const googleConfig = vi.hoisted(() => ({
  grantedScopes: ["https://www.googleapis.com/auth/gmail.modify"],
}));

vi.mock("../../googleSettings.ts", () => ({
  getGoogleToolConfig: () => ({ enabled: true, ...googleConfig }),
  ensureGoogleAccessToken: async () => "gmail-token",
}));

const { googleGmailArchiveTool } = await import("./googleGmailArchiveTools.ts");
const { approvalsForSession, resolveApproval, setApprovalBroadcastForTests } =
  await import("../../pendingApprovals.ts");

let sessionCounter = 0;

function context(sessionId: string) {
  return {
    toolCallId: `call-${sessionId}`,
    session: {
      sessionId,
      harness: "pi" as const,
      agentType: "personal-assistant" as const,
    },
    signal: new AbortController().signal,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(
  id: string,
  threadId: string,
  labels: string[],
  from: string,
  subject: string,
) {
  return {
    id,
    threadId,
    labelIds: labels,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
      ],
    },
  };
}

beforeEach(() => {
  googleConfig.grantedScopes = ["https://www.googleapis.com/auth/gmail.modify"];
});

afterEach(() => {
  vi.restoreAllMocks();
  setApprovalBroadcastForTests(null);
});

describe("google_gmail_archive", () => {
  test("freezes every inbox message on one approval and archives them in one batch", async () => {
    setApprovalBroadcastForTests(() => {});
    const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url, init });
      if (url.pathname.endsWith("/threads/thread-a"))
        return jsonResponse({
          id: "thread-a",
          messages: [
            message(
              "message-a",
              "thread-a",
              ["INBOX", "UNREAD"],
              "Alice Example <alice@example.com>",
              "Quarterly plan",
            ),
            message(
              "sent-reply",
              "thread-a",
              ["SENT"],
              "Me <me@example.com>",
              "Re: Quarterly plan",
            ),
          ],
        });
      if (url.pathname.endsWith("/threads/thread-b"))
        return jsonResponse({
          id: "thread-b",
          messages: [
            message(
              "message-b",
              "thread-b",
              ["INBOX"],
              "Bob Example <bob@example.com>",
              "Travel receipt",
            ),
          ],
        });
      if (url.pathname.endsWith("/messages/batchModify"))
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected Gmail request: ${url}`);
    });

    const sessionId = `gmail-archive-${(sessionCounter += 1)}`;
    const result = await googleGmailArchiveTool.execute(
      { threadIds: ["thread-a", "thread-b", "thread-a"] },
      context(sessionId),
    );

    expect(result.terminate).toBe(true);
    expect(requests.filter(({ init }) => init?.method === "POST")).toHaveLength(
      0,
    );
    const approval = approvalsForSession(sessionId).at(-1)!;
    expect(approval).toMatchObject({
      kind: "gmailArchive",
      status: "pending",
      title: "Archive 2 emails",
      sourceToolCallId: `call-${sessionId}`,
      body: {
        kind: "gmailArchive",
        items: [
          {
            messageId: "message-a",
            threadId: "thread-a",
            sender: "Alice Example <alice@example.com>",
            subject: "Quarterly plan",
          },
          {
            messageId: "message-b",
            threadId: "thread-b",
            sender: "Bob Example <bob@example.com>",
            subject: "Travel receipt",
          },
        ],
      },
    });

    const resolved = await resolveApproval(approval.id, "approved");
    expect(resolved.card.status).toBe("executed");
    expect(resolved.card.resultSummary).toBe("Archived 2 emails");
    const writes = requests.filter(({ init }) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url.pathname).toMatch(/\/messages\/batchModify$/);
    expect(JSON.parse(String(writes[0]!.init?.body))).toEqual({
      ids: ["message-a", "message-b"],
      removeLabelIds: ["INBOX"],
    });
  });

  test("refuses to stage when the connected grant is still read-only", async () => {
    googleConfig.grantedScopes = [
      "https://www.googleapis.com/auth/gmail.readonly",
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      googleGmailArchiveTool.execute(
        { threadIds: ["thread-old-scope"] },
        context(`gmail-scope-${(sessionCounter += 1)}`),
      ),
    ).rejects.toThrow(/Reauthorize Google Workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("reports an unconfirmed API failure without claiming the inbox was unchanged", async () => {
    setApprovalBroadcastForTests(() => {});
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-failed",
          messages: [
            message(
              "message-failed",
              "thread-failed",
              ["INBOX"],
              "Dora <dora@example.com>",
              "Permission test",
            ),
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
    const sessionId = `gmail-failed-${(sessionCounter += 1)}`;
    await googleGmailArchiveTool.execute(
      { threadIds: ["thread-failed"] },
      context(sessionId),
    );

    const approval = approvalsForSession(sessionId).at(-1)!;
    const resolved = await resolveApproval(approval.id, "approved");
    expect(resolved.card.status).toBe("failed");
    expect(resolved.card.error).toMatch(/Reconnect Google Workspace/);
    expect(resolved.card.error).toMatch(/did not confirm the archive/);
  });

  test("rejects a selection too large for a durable review card", async () => {
    const messages = Array.from({ length: 201 }, (_, index) =>
      message(
        `message-${index}`,
        "thread-large",
        ["INBOX"],
        `Sender ${index} <sender-${index}@example.com>`,
        `Subject ${index}`,
      ),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ id: "thread-large", messages }),
    );

    await expect(
      googleGmailArchiveTool.execute(
        { threadIds: ["thread-large"] },
        context(`gmail-large-${(sessionCounter += 1)}`),
      ),
    ).rejects.toThrow(/at most 200 messages/);
  });

  test("a rejection leaves Gmail unchanged", async () => {
    setApprovalBroadcastForTests(() => {});
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        id: "thread-c",
        messages: [
          message(
            "message-c",
            "thread-c",
            ["INBOX"],
            "Carol <carol@example.com>",
            "Keep this",
          ),
        ],
      }),
    );
    const sessionId = `gmail-reject-${(sessionCounter += 1)}`;
    await googleGmailArchiveTool.execute(
      { threadIds: ["thread-c"] },
      context(sessionId),
    );

    const approval = approvalsForSession(sessionId).at(-1)!;
    const resolved = await resolveApproval(approval.id, "rejected");
    expect(resolved.card.status).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
