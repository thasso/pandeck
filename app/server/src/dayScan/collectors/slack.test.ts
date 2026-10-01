import assert from "node:assert/strict";
import { test } from "vitest";
import { slackMessageFact } from "./slack.ts";
import type { SlackDaySignalConfig } from "../../slackSettings.ts";

const CONFIG: SlackDaySignalConfig = {
  token: "xoxp-test",
  accountUserId: "U123",
  workspaceHost: "acme.slack.com",
  teamId: "T1",
  timezone: "Europe/Berlin",
};
const OBSERVED = "2026-07-23T10:00:00.000Z";

test("a mention fact commits ONLY metadata — never message body text (Task 140 privacy gate)", () => {
  const fact = slackMessageFact(
    "slack-mention",
    CONFIG,
    {
      ts: "1753257600.000100",
      channel: { id: "C42", name: "drm-team" },
      permalink: "https://acme.slack.com/archives/C42/p1753257600000100",
    },
    OBSERVED,
  )!;
  assert.equal(fact.kind, "slack-mention");
  assert.equal(fact.id, "slack-mention:C42:1753257600.000100");
  // Title is a synthesized label, not content.
  assert.equal(fact.title, "Mentioned in #drm-team");
  assert.ok(fact.tags?.includes("attention"));
  // The committed data carries ONLY metadata keys — no body/text/preview.
  assert.deepEqual(Object.keys(fact.data ?? {}).sort(), [
    "channelId",
    "channelName",
    "ts",
  ]);
  const serialized = JSON.stringify(fact);
  assert.ok(
    !/text|body|preview|blocks/i.test(serialized),
    "no body-like keys are committed",
  );
});

test("own-message fact builds a permalink from channel+ts when none is supplied", () => {
  const fact = slackMessageFact(
    "slack-own",
    CONFIG,
    { ts: "1753257600.000200", channel: { id: "C7", name: "general" } },
    OBSERVED,
  )!;
  assert.equal(fact.title, "You posted in #general");
  assert.deepEqual(fact.tags, ["own"]);
  assert.equal(
    fact.links?.[0],
    "https://acme.slack.com/archives/C7/p1753257600000200",
  );
});

test("a match without a channel id or ts is dropped", () => {
  assert.equal(
    slackMessageFact(
      "slack-own",
      CONFIG,
      { ts: "1753257600.000300" },
      OBSERVED,
    ),
    null,
  );
  assert.equal(
    slackMessageFact("slack-own", CONFIG, { channel: { id: "C1" } }, OBSERVED),
    null,
  );
});
