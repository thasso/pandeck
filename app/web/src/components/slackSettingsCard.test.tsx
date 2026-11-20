// @vitest-environment jsdom
/**
 * Settings → Slack in client mode (Task-1455): the gateway holds the Slack
 * connection, so the panel only turns Slack's tools on and off, never checks
 * or signs in locally, even when old local tokens are still stored. Outside
 * client mode the local sign-in flow is unchanged.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings, SlackSettingsPatch } from "@assistant/shared";
import { SettingsPage } from "./SettingsPage.tsx";
import { ready } from "../lib/loadState.ts";
import {
  settingsFixture,
  settingsMemory,
  settingsModels,
  settingsPrefs,
  settingsProfiles,
  settingsSkills,
} from "../../component-preview/fixtures/settings.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const noop = () => {};

async function renderSlack(
  slack: Partial<AppSettings["slack"]>,
  handlers: {
    onSaveAndTest?: (patch: SlackSettingsPatch) => void;
    onTest?: () => void;
  } = {},
): Promise<string> {
  const settings: AppSettings = {
    ...settingsFixture,
    slack: { ...settingsFixture.slack, ...slack },
  };
  await act(async () =>
    root!.render(
      <SettingsPage
        section="slack"
        settings={settings}
        prefs={settingsPrefs}
        models={settingsModels}
        accountModels={settingsModels}
        credentialProfiles={settingsProfiles}
        projects={[]}
        memory={settingsMemory}
        skills={ready(settingsSkills)}
        agents={ready({ ...settingsSkills, entries: [] })}
        serverBuild={null}
        speechToText={null}
        modelsRefreshing={false}
        onUpdate={noop}
        onUpdatePrefs={noop}
        onToggleSkill={noop}
        onRefreshModels={noop}
        onSaveAndTestJira={noop}
        onTestJira={noop}
        jiraStatus={null}
        onSaveAndTestConfluence={noop}
        onTestConfluence={noop}
        confluenceStatus={null}
        onUpdateTempo={noop}
        onSaveAndTestTempo={noop}
        onTestTempo={noop}
        tempoStatus={null}
        onUpdateGoogle={noop}
        onSaveAndTestGoogle={noop}
        onTestGoogle={noop}
        googleStatus={null}
        onSaveAndTestSlack={handlers.onSaveAndTest ?? noop}
        onTestSlack={handlers.onTest ?? noop}
        slackStatus={null}
        onSaveAndTestBrave={noop}
        onTestBrave={noop}
        braveStatus={null}
        onSaveAndTestContext7={noop}
        onTestContext7={noop}
        context7Status={null}
        onSaveAndTestGithub={noop}
        onTestGithub={noop}
        githubStatus={null}
        onSaveAndTestForgejo={noop}
        onTestForgejo={noop}
        forgejoStatus={null}
      />,
    ),
  );
  return container!.textContent?.replace(/\s+/g, " ") ?? "";
}

const buttonNamed = (label: string) =>
  [...container!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
const toggle = () =>
  container!.querySelector<HTMLElement>('[aria-label="Enable Slack"]')!;
const toggleDisabled = () => toggle().hasAttribute("data-disabled");

const BADGES = [
  "Connected to Slack",
  "Not connected",
  "Checking Slack connection…",
  "Slack needs attention",
];

it("client mode with stale local tokens: no check, sign-in or status; the toggle turns Slack on", async () => {
  const onTest = vi.fn();
  const onSaveAndTest = vi.fn();
  const text = await renderSlack(
    {
      credentialStore: "gateway",
      connected: true,
      userTokenConfigured: true,
      botTokenConfigured: true,
      enabled: false,
    },
    { onTest, onSaveAndTest },
  );
  expect(onTest).not.toHaveBeenCalled();
  expect(buttonNamed("Sign in with Slack")).toBeUndefined();
  expect(buttonNamed("Sign out")).toBeUndefined();
  for (const badge of BADGES) expect(text).not.toContain(badge);
  expect(text).toContain(
    "Slack is connected through your gateway's page: use Sign in with Slack there. Nothing is entered on this machine.",
  );
  expect(text).toContain(
    "Allow the Assistant to use the Slack account you connected on your gateway.",
  );
  expect(text).toContain(
    "Whether Slack is connected shows on your gateway's page.",
  );
  expect(toggleDisabled()).toBe(false);
  await act(async () => toggle().click());
  expect(onSaveAndTest).toHaveBeenCalledWith({ enabled: true });
  expect(onTest).not.toHaveBeenCalled();
});

it("client mode without local tokens: the toggle is usable and there is no sign-in", async () => {
  await renderSlack({
    credentialStore: "gateway",
    connected: false,
    userTokenConfigured: false,
    botTokenConfigured: false,
  });
  expect(toggleDisabled()).toBe(false);
  expect(buttonNamed("Sign in with Slack")).toBeUndefined();
});

it("locally connected: checks the connection once on open", async () => {
  const onTest = vi.fn();
  const text = await renderSlack(
    { credentialStore: "local", connected: true },
    { onTest },
  );
  expect(onTest).toHaveBeenCalledTimes(1);
  expect(buttonNamed("Sign out")).toBeDefined();
  expect(text).not.toContain("gateway");
});

it("locally not connected: the toggle waits for Sign in with Slack", async () => {
  await renderSlack({
    credentialStore: "local",
    connected: false,
    userTokenConfigured: false,
    botTokenConfigured: false,
    enabled: false,
  });
  expect(toggleDisabled()).toBe(true);
  expect(buttonNamed("Sign in with Slack")).toBeDefined();
});
