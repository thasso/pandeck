// @vitest-environment jsdom
/**
 * Settings → Jira says where the token is kept: server-side here, or on the
 * credential gateway in client mode (Task-1397). Fields and flow are the same.
 * A gateway that connects Jira only with Sign in with Atlassian on its page
 * (Task-1411) takes no email or token here: enable, save-and-test and clear
 * stay, and no separate Test button.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings, JiraSettingsPatch } from "@assistant/shared";
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

async function renderJira(
  credentialStore: AppSettings["jira"]["credentialStore"],
  over: Partial<AppSettings["jira"]> = {},
  handlers: {
    onSaveAndTest?: (patch: JiraSettingsPatch) => void;
    onTest?: () => void;
  } = {},
): Promise<string> {
  const settings: AppSettings = {
    ...settingsFixture,
    jira: {
      ...settingsFixture.jira,
      atlassianTokenConfigured: false,
      credentialStore,
      ...over,
    },
  };
  await act(async () =>
    root!.render(
      <SettingsPage
        section="jira"
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
        onSaveAndTestJira={handlers.onSaveAndTest ?? noop}
        onTestJira={handlers.onTest ?? noop}
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
        onSaveAndTestSlack={noop}
        onTestSlack={noop}
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

it("says the token stays on the gateway in client mode", async () => {
  const text = await renderJira("gateway");
  expect(text).toContain(
    "The token is kept on your gateway, not on this machine.",
  );
  expect(text).not.toContain("stored server-side");
  expect(text).toContain("Atlassian API token");
});

it("keeps the local copy otherwise", async () => {
  const text = await renderJira("local");
  expect(text).toContain(
    "The token is stored server-side and never sent back to the browser.",
  );
  expect(text).not.toContain("kept on your gateway");
});

const buttonNamed = (label: string) =>
  [...container!.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );

it("a sign-in gateway: no email or token fields; Save and test sends exactly enabled, Clear removes", async () => {
  const onSaveAndTest = vi.fn<(patch: JiraSettingsPatch) => void>();
  const onTest = vi.fn();
  const text = await renderJira(
    "gateway",
    {
      enabled: false,
      atlassianTokenConfigured: true,
      gatewayKind: "oauth",
      gatewaySignIn: true,
    },
    { onSaveAndTest, onTest },
  );
  expect(text).toContain("use Sign in with Atlassian there");
  expect(text).not.toContain("Atlassian API token");
  expect(text).not.toContain("Atlassian email");
  expect(container!.querySelector('input[type="password"]')).toBeNull();
  expect(
    container!.querySelector('input[placeholder="you@example.com"]'),
  ).toBeNull();
  for (const word of ["OAuth", "scope", "Basic auth"])
    expect(text).not.toContain(word);
  // Opening the card checks the stored connection once.
  expect(onTest).toHaveBeenCalledTimes(1);

  const toggle = container!.querySelector<HTMLElement>('[role="switch"]')!;
  await act(async () => toggle.click());
  expect(buttonNamed("Test")).toBeUndefined();
  expect(buttonNamed("Save")).toBeUndefined();
  await act(async () => buttonNamed("Save and test")!.click());
  expect(onSaveAndTest).toHaveBeenCalledTimes(1);
  expect(onSaveAndTest.mock.calls[0]![0]).toStrictEqual({ enabled: true });
  expect(onTest).toHaveBeenCalledTimes(1);
  await act(async () => buttonNamed("Clear")!.click());
  expect(onSaveAndTest).toHaveBeenLastCalledWith({
    enabled: true,
    clearAtlassianToken: true,
  });
});

it("a sign-in gateway with nothing stored: no Clear, the page remedy", async () => {
  const text = await renderJira("gateway", {
    atlassianTokenConfigured: false,
    gatewaySignIn: true,
  });
  expect(text).toContain(
    "Not connected yet. Sign in with Atlassian on your gateway's page.",
  );
  expect(buttonNamed("Clear")).toBeUndefined();
  expect(buttonNamed("Test")).toBeUndefined();
  expect(buttonNamed("Save and test")).toBeDefined();
});

it("a sign-in gateway keeping an old API token says so and keeps Clear", async () => {
  const text = await renderJira("gateway", {
    atlassianTokenConfigured: true,
    gatewayKind: "token",
    gatewaySignIn: true,
  });
  expect(text).toContain("Your gateway keeps an API token for Jira.");
  expect(buttonNamed("Clear")).toBeDefined();
});

it("a token gateway keeps today's form", async () => {
  const text = await renderJira("gateway", {
    atlassianTokenConfigured: true,
    gatewaySignIn: false,
  });
  expect(text).toContain("Atlassian API token");
  expect(text).toContain("Atlassian email");
  expect(buttonNamed("Save and test")).toBeDefined();
  expect(buttonNamed("Clear token")).toBeDefined();
  expect(text).not.toContain("Sign in with Atlassian");
});
