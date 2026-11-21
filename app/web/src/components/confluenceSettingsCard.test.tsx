// @vitest-environment jsdom
/**
 * Settings → Confluence in client mode (Task-1439): the reads run on the
 * gateway's Atlassian connection, so the card says so and warns only when the
 * gateway has none stored. Outside client mode the text is unchanged.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppSettings, ConfluenceSettingsPatch } from "@assistant/shared";
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

async function renderConfluence(
  confluence: Partial<AppSettings["confluence"]>,
  handlers: {
    onSaveAndTest?: (patch: ConfluenceSettingsPatch) => void;
    onTest?: () => void;
  } = {},
): Promise<string> {
  const settings: AppSettings = {
    ...settingsFixture,
    confluence: { ...settingsFixture.confluence, ...confluence },
  };
  await act(async () =>
    root!.render(
      <SettingsPage
        section="confluence"
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
        onSaveAndTestConfluence={handlers.onSaveAndTest ?? noop}
        onTestConfluence={handlers.onTest ?? noop}
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

const buttonNamed = (label: string) =>
  [...container!.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );

const GATEWAY = "Uses the gateway's Atlassian connection (Settings → Jira).";
const LOCAL =
  "Confluence is the same Atlassian site as Jira and uses the email and API token saved there.";
const GATEWAY_WARNING =
  "No Atlassian connection on the gateway yet. Connect Atlassian under Settings → Jira.";
const LOCAL_WARNING = "No Atlassian credentials yet.";

it("client mode with a stored connection: gateway text, no warning, Save and test stays", async () => {
  const onTest = vi.fn();
  const onSaveAndTest = vi.fn();
  const text = await renderConfluence(
    { credentialStore: "gateway", credentialsAvailable: true, enabled: true },
    { onTest, onSaveAndTest },
  );
  expect(text).toContain(GATEWAY);
  expect(text).not.toContain(LOCAL);
  expect(text).not.toContain(GATEWAY_WARNING);
  expect(text).not.toContain(LOCAL_WARNING);
  // The connection test still runs on open; the server answers without a call.
  expect(onTest).toHaveBeenCalledTimes(1);
  await act(async () => buttonNamed("Save and test")!.click());
  expect(onSaveAndTest).toHaveBeenCalledWith({ enabled: true });
});

it("client mode without a stored connection: the gateway warning", async () => {
  const onTest = vi.fn();
  const text = await renderConfluence(
    { credentialStore: "gateway", credentialsAvailable: false },
    { onTest },
  );
  expect(text).toContain(GATEWAY);
  expect(text).toContain(GATEWAY_WARNING);
  expect(text).not.toContain(LOCAL_WARNING);
  expect(onTest).not.toHaveBeenCalled();
  expect(buttonNamed("Save and test")).toBeDefined();
});

it("locally: today's text and warning, never the gateway's", async () => {
  const withCredentials = await renderConfluence({
    credentialsAvailable: true,
  });
  expect(withCredentials).toContain(LOCAL);
  expect(withCredentials).not.toContain("gateway");

  const without = await renderConfluence({ credentialsAvailable: false });
  expect(without).toContain(LOCAL);
  expect(without).toContain(
    "No Atlassian credentials yet. Enable Jira and save an email and API token under Settings → Jira; Confluence shares them.",
  );
  expect(without).not.toContain("gateway");
});
