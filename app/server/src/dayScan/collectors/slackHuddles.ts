import { getSlackHuddleConfig } from "../../slackSettings.ts";
import { collectOwnHuddleAttendanceForDay } from "../../tools/slack/slackHuddleTools.ts";
import type {
  CollectorOutput,
  DayCollectContext,
  DaySourceCollector,
  DaySourceFact,
} from "../types.ts";

/**
 * Slack Huddle ATTENDANCE (Task 171): the huddles the connected user actually
 * joined on the day, so real-time voice work shows up as MY work (and gets a
 * defensible duration for time logging). Privacy: OWN attendance only — channel
 * id, timing, and my duration; never a participant list or message content. It
 * relies on the experimental browser-session capability, so the source is only
 * READY when that is enabled/configured; otherwise it is skipped like any other
 * unconfigured source. A fetch failure degrades to `partial` (the undocumented
 * Slack browser API can break independently), never a hard scan failure.
 */
export const slackHuddlesCollector: DaySourceCollector = {
  key: "slack-huddles",
  label: "Slack Huddles",
  readiness() {
    try {
      getSlackHuddleConfig();
      return { ready: true };
    } catch (err) {
      return {
        ready: false,
        reason: "unconfigured",
        detail:
          err instanceof Error ? err.message : "Slack Huddles is not connected",
      };
    }
  },
  async collect(ctx: DayCollectContext): Promise<CollectorOutput> {
    const config = getSlackHuddleConfig();
    const observedAt = new Date().toISOString();
    let records;
    try {
      records = await collectOwnHuddleAttendanceForDay(
        config,
        ctx.date,
        ctx.signal,
      );
    } catch (err) {
      ctx.cache.writeJson(ctx.date, "slack-huddles-raw", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        result: "partial",
        facts: [],
        notes: [
          "Slack Huddle history could not be read; the experimental browser session may need refreshing.",
        ],
      };
    }

    // `huddles.history` is the connected user's OWN huddle list, so every
    // returned huddle for the day is surfaced (the user expects to SEE their
    // huddles). Only the ones I actually joined are tagged `own`/`attended` (my
    // work + a duration for time logging); the rest show as context. When self
    // status is unknown (missing account id / shape drift) we still show the
    // huddle rather than hide it, but do not claim attendance.
    const facts: DaySourceFact[] = [];
    let attended = 0;
    for (const record of records) {
      const joined = record.selfStatus === "joined";
      if (joined) attended += 1;
      const id =
        record.id ?? `${record.channelId ?? "unknown"}:${record.start ?? "?"}`;
      facts.push({
        id: `huddle:${id}`,
        kind: "huddle",
        occurredAt: record.start
          ? new Date(record.start * 1000).toISOString()
          : null,
        observedAt,
        title: joined ? "Slack huddle (attended)" : "Slack huddle",
        links: record.huddleLink ? [record.huddleLink] : [],
        data: {
          channelId: record.channelId,
          start: record.start,
          end: record.end,
          durationSeconds: record.durationSeconds,
          selfStatus: record.selfStatus,
          participantCount: record.participantCount,
          // WHO was in it (names via personal OAuth) — the key context for what
          // the huddle was about, for time tracking. Names + status only.
          participants: record.participants.map((p) => ({
            name: p.name,
            self: p.self,
            status: p.status,
          })),
        },
        tags: joined ? ["own", "attended", "huddle"] : ["huddle"],
      });
    }
    ctx.cache.writeJson(ctx.date, "slack-huddles-raw", {
      returned: records.length,
      attended,
    });
    return {
      result: "complete",
      facts,
      completeness: { returned: records.length, attended },
    };
  },
};
