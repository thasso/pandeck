import { expect, it } from "vitest";
import { appStatus, type AppStatusInput } from "./appStatus.ts";

const input: AppStatusInput = {
  connected: true,
  reloading: null,
  hydrationSource: "live",
  graceElapsed: true,
  accountLoginAlerts: [
    { profileId: "a", name: "Claude Private", provider: "claude" },
  ],
};
it("names one dead login, counts several, and links to provider settings", () => {
  expect(appStatus(input)).toEqual({
    kind: "needs-login",
    label: "Claude Private needs login",
    busy: false,
    href: "/settings/claude-sdk",
  });
  expect(
    appStatus({
      ...input,
      accountLoginAlerts: [
        { profileId: "b", name: "OpenAI", provider: "openai-codex" },
        ...input.accountLoginAlerts!,
      ],
    }),
  ).toEqual({
    kind: "needs-login",
    label: "2 accounts need login",
    busy: false,
    href: "/settings/openai",
  });
  expect(appStatus({ ...input, accountLoginAlerts: [] })).toBeNull();
});
it("ranks restart and connection above login without bypassing the connection grace period", () => {
  expect(appStatus({ ...input, reloading: { phase: "pending" } })?.kind).toBe(
    "restart-queued",
  );
  expect(appStatus({ ...input, reloading: { phase: "reloading" } })?.kind).toBe(
    "restarting",
  );
  expect(appStatus({ ...input, connected: false })?.kind).toBe("reconnecting");
  expect(
    appStatus({ ...input, connected: false, graceElapsed: false }),
  ).toBeNull();
});
