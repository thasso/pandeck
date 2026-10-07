import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../googleSettings.ts", () => ({
  getGoogleToolConfig: () => ({ enabled: true }),
  ensureGoogleAccessToken: async () => "calendar-token",
}));
vi.mock("../../userProfile.ts", () => ({
  userTimeZone: () => "Europe/Berlin",
}));
vi.mock("../../googleWorkspaceLinking.ts", () => ({
  findMeetRecordsForCalendarEvent: vi.fn(async () => []),
}));

import { findMeetRecordsForCalendarEvent } from "../../googleWorkspaceLinking.ts";
import { assistantGoogleCalendarTools } from "./googleCalendarTools.ts";

const tool = assistantGoogleCalendarTools[0]!;
const context = {
  toolCallId: "calendar-test",
  session: {
    sessionId: "calendar-test",
    harness: "pi" as const,
    agentType: "assistant" as const,
  },
  signal: new AbortController().signal,
};

function event(id: string, responseStatus = "accepted") {
  return {
    id,
    summary: "Planning",
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    start: { dateTime: "2026-07-06T08:00:00Z" },
    end: { dateTime: "2026-07-06T09:00:00Z" },
    description: "Agenda",
    attendees: [{ email: "me@example.com", self: true, responseStatus }],
    conferenceData: {
      conferenceId: "abc-defg-hij",
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [
        {
          entryPointType: "video",
          uri: "https://meet.google.com/abc-defg-hij",
        },
      ],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("retained Google Calendar agent tool", () => {
  test("lists a bounded user-local day with auth, pagination and declined filtering", async () => {
    const requests: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer calendar-token",
      });
      return Response.json(
        url.searchParams.has("pageToken")
          ? {
              items: [
                event("declined", "declined"),
                { ...event("cancelled"), status: "cancelled" },
              ],
            }
          : {
              summary: "Work",
              timeZone: "Europe/Berlin",
              items: [event("accepted")],
              nextPageToken: "page-2",
            },
      );
    });
    const result = await tool.execute(
      { date: "2026-07-06", includeDeclined: false },
      context,
    );
    const payload = JSON.parse(
      result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]!.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(requests[0]!.searchParams.get("timeMin")).toBe(
      "2026-07-05T22:00:00.000Z",
    );
    expect(requests[0]!.searchParams.get("timeMax")).toBe(
      "2026-07-06T22:00:00.000Z",
    );
    expect(payload.eventCount).toBe(1);
    expect(payload.events[0]).toMatchObject({
      id: "accepted",
      title: "Planning",
    });
    expect(payload.events[0].markdownLink).toContain(
      "https://calendar.google.com/event?eid=accepted",
    );
    expect(findMeetRecordsForCalendarEvent).not.toHaveBeenCalled();
  });

  test("keeps rich tool-card output and optional Meet attendance lookup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ items: [event("rich")] }),
    );
    const result = await tool.execute(
      { date: "2026-07-06", render: true },
      context,
    );
    const payload = JSON.parse(
      result.content[0]!.type === "text" ? result.content[0]!.text : "{}",
    );
    expect(payload).toMatchObject({
      renderRequested: true,
      detailLevel: "full",
      eventCount: 1,
    });
    expect(payload.events[0]).toMatchObject({
      description: "Agenda",
      attendees: [{ self: true, responseStatus: "accepted" }],
    });
    expect(findMeetRecordsForCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        includeArtifacts: true,
        includeParticipants: true,
      }),
    );
  });

  test("refuses an unbounded query before requesting credentials or events", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(tool.execute({}, context)).rejects.toThrow(
      "Provide date or both from and to",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
