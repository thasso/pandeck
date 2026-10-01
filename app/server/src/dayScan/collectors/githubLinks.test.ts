import assert from "node:assert/strict";
import { test } from "vitest";
import {
  apiUrlToHtml,
  eventHtmlLink,
  notificationHtmlLink,
} from "./githubLinks.ts";

test("eventHtmlLink prefers the specific PR/issue html_url", () => {
  assert.equal(
    eventHtmlLink("o/r", {
      type: "PullRequestEvent",
      payload: { pull_request: { html_url: "https://github.com/o/r/pull/12" } },
    }),
    "https://github.com/o/r/pull/12",
  );
  assert.equal(
    eventHtmlLink("o/r", {
      type: "IssuesEvent",
      payload: { issue: { html_url: "https://github.com/o/r/issues/7" } },
    }),
    "https://github.com/o/r/issues/7",
  );
});

test("eventHtmlLink builds a commit/branch link for pushes and creates", () => {
  assert.equal(
    eventHtmlLink("o/r", {
      type: "PushEvent",
      payload: { head: "abc123", ref: "refs/heads/main" },
    }),
    "https://github.com/o/r/commit/abc123",
  );
  assert.equal(
    eventHtmlLink("o/r", {
      type: "PushEvent",
      payload: { ref: "refs/heads/feat/x" },
    }),
    "https://github.com/o/r/commits/feat%2Fx",
  );
  assert.equal(
    eventHtmlLink("o/r", { type: "CreateEvent", payload: { ref: "v1.2" } }),
    "https://github.com/o/r/tree/v1.2",
  );
});

test("eventHtmlLink falls back to the repo URL", () => {
  assert.equal(
    eventHtmlLink("o/r", { type: "WatchEvent", payload: {} }),
    "https://github.com/o/r",
  );
  assert.equal(eventHtmlLink(null, { type: "PushEvent" }), null);
});

test("apiUrlToHtml converts REST subject URLs to human URLs", () => {
  assert.equal(
    apiUrlToHtml("https://api.github.com/repos/o/r/pulls/9"),
    "https://github.com/o/r/pull/9",
  );
  assert.equal(
    apiUrlToHtml("https://api.github.com/repos/o/r/issues/3"),
    "https://github.com/o/r/issues/3",
  );
  assert.equal(
    apiUrlToHtml("https://api.github.com/repos/o/r/commits/deadbeef"),
    "https://github.com/o/r/commit/deadbeef",
  );
  assert.equal(
    apiUrlToHtml("https://api.github.com/repos/o/r/releases/55"),
    null,
  ); // release api id is not the html slug
  assert.equal(apiUrlToHtml(null), null);
});

test("notificationHtmlLink prefers the subject target, else the repo", () => {
  assert.equal(
    notificationHtmlLink(
      "https://api.github.com/repos/o/r/pulls/9",
      "https://github.com/o/r",
    ),
    "https://github.com/o/r/pull/9",
  );
  assert.equal(
    notificationHtmlLink(null, "https://github.com/o/r"),
    "https://github.com/o/r",
  );
  assert.equal(
    notificationHtmlLink(
      "https://api.github.com/repos/o/r/releases/1",
      "https://github.com/o/r",
    ),
    "https://github.com/o/r",
  );
});
