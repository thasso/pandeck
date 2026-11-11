// @vitest-environment jsdom
/**
 * Settings → Jira says where the token is kept: server-side here, or on the
 * credential gateway in client mode (Task-1397). Fields and flow are the same.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AppSettings } from "@assistant/shared";
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
): Promise<string> {
  const settings: AppSettings = {
    ...settingsFixture,
    jira: {
      ...settingsFixture.jira,
      atlassianTokenConfigured: false,
      credentialStore,
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
