import { describe, expect, it } from "vitest";
import { parseSlackBrowserCurl } from "./SettingsPage.tsx";

describe("Slack Huddle cURL intake", () => {
  it("retains only the browser token and d cookie from huddles.history", () => {
    const parsed =
      parseSlackBrowserCurl(`curl 'https://example.slack.com/api/huddles.history?slack_route=T1&_x_version_ts=123' \\
      -H 'authorization: Bearer xoxc-browser' \\
      -H 'cookie: d=cookie-value; other=sensitive'`);

    expect(parsed.error).toBeUndefined();
    expect(parsed.patch).toEqual({
      clientToken: "xoxc-browser",
      clientCookieD: "cookie-value",
    });
    expect(parsed.found).toEqual(["browser token", "d cookie"]);
  });

  it("rejects copied requests for other private Slack APIs", () => {
    const parsed = parseSlackBrowserCurl(
      `curl 'https://example.slack.com/api/saved.list' -H 'authorization: Bearer xoxc-browser' -H 'cookie: d=cookie-value'`,
    );
    expect(parsed.error).toMatch(
      /not a copied Slack huddles\.history request/i,
    );
    expect(parsed.patch).toEqual({});
  });
});
