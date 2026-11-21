import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { AppSettings } from "@assistant/shared";
import { settingDescriptor } from "@assistant/shared/settingsRegistry";
import { getSettings } from "../../settings.ts";
import { TESTABLE_SETTINGS_SECTIONS } from "../../settingsService.ts";
import {
  CHAT_INTEGRATIONS,
  chatIntegrationStates,
  integrationSetupTools,
} from "./integrationSetupTools.ts";

/** The current settings with the deployment's Atlassian site and OAuth clients set or not. */
function deployment(configured: boolean): AppSettings {
  const settings = structuredClone(getSettings());
  settings.jira.jiraHost = configured ? "example.atlassian.net" : "";
  settings.confluence.confluenceHost = configured
    ? "example.atlassian.net"
    : "";
  settings.google.oauthClientConfigured = configured;
  settings.slack.oauthClientConfigured = configured;
  settings.tempo.oauthClientConfigured = configured;
  return settings;
}

/** One reported integration, either shape. */
interface Reported {
  section: string;
  name: string;
  on: boolean;
  credentialSet?: boolean;
  available: boolean;
  blocker?: string;
  setup?: { credential?: string; turnOn: string };
}

const bySection = (settings: AppSettings) =>
  new Map<string, Reported>(
    chatIntegrationStates(settings).map((entry) => [entry.section, entry]),
  );

describe("integration_setup_read", () => {
  test("every path it names is a real setting of the right kind", () => {
    for (const integration of CHAT_INTEGRATIONS) {
      const turnOn = settingDescriptor(integration.turnOn);
      assert.equal(turnOn?.access, "value", integration.turnOn);
      assert.equal(turnOn?.value?.kind, "boolean", integration.turnOn);
      assert.equal(turnOn?.section, integration.section);
      for (const path of [
        ...(integration.ask ?? []),
        ...(integration.optional ?? []),
      ]) {
        assert.equal(settingDescriptor(path)?.access, "value", path);
        assert.equal(settingDescriptor(path)?.section, integration.section);
      }
      if (integration.credential) {
        const credential = settingDescriptor(integration.credential);
        assert.ok(
          credential?.access === "secret" || credential?.access === "oauth",
          integration.credential,
        );
      }
      for (const { path } of integration.requires ?? [])
        assert.equal(settingDescriptor(path)?.access, "readonly", path);
      assert.ok(TESTABLE_SETTINGS_SECTIONS.includes(integration.section));
    }
  });

  test("offers no GitHub, Context7 or browser setup", () => {
    const sections = CHAT_INTEGRATIONS.map((i) => i.section);
    assert.deepEqual(sections, [
      "forgejo",
      "jira",
      "confluence",
      "google",
      "slack",
      "tempo",
      "web-search",
    ]);
  });

  test("without an Atlassian site or OAuth clients, only Forgejo and web search are available", () => {
    const states = bySection(deployment(false));
    assert.equal(states.get("forgejo")?.available, true);
    assert.equal(states.get("web-search")?.available, true);
    for (const section of ["jira", "confluence", "google", "slack", "tempo"]) {
      const entry = states.get(section);
      assert.equal(entry?.available, false, section);
      assert.match(entry?.blocker ?? "", /deployment config/, section);
      assert.ok(!("setup" in entry!), `${section} offers no setup steps`);
    }
    assert.match(states.get("google")!.blocker!, /Google OAuth client/);
    assert.match(
      states.get("tempo")!.blocker!,
      /Tempo OAuth client.*Atlassian/,
    );
  });

  test("a configured deployment makes each available with its steps", () => {
    const states = bySection(deployment(true));
    for (const entry of states.values())
      assert.equal(entry.available, true, entry.section);
    assert.deepEqual(states.get("forgejo")?.setup, {
      ask: ["forgejo.baseUrl"],
      optional: ["forgejo.defaultOwner"],
      credential: "forgejo.token",
      turnOn: "forgejo.enabled",
      test: "forgejo",
      note: CHAT_INTEGRATIONS[0]!.note,
    });
    assert.deepEqual(states.get("confluence")?.setup, {
      uses: "jira",
      turnOn: "confluence.enabled",
      test: "confluence",
    });
    assert.equal(states.get("jira")?.setup?.credential, "jira.atlassianToken");
    assert.equal(states.get("google")?.setup?.credential, "google.connection");
    assert.equal(states.get("web-search")?.setup?.turnOn, "brave.enabled");
    assert.equal(states.get("web-search")?.name, "Web search");
  });

  test("reports whether each is on and its credential set", () => {
    const settings = deployment(true);
    settings.brave.enabled = true;
    settings.brave.apiKeyConfigured = true;
    settings.slack.connected = false;
    const states = bySection(settings);
    assert.equal(states.get("web-search")?.on, true);
    assert.equal(states.get("web-search")?.credentialSet, true);
    assert.equal(states.get("slack")?.credentialSet, false);
    assert.ok(!("credentialSet" in states.get("confluence")!));
  });

  test("the tool answers from the current settings", async () => {
    const result = await integrationSetupTools[0]!.execute({}, {} as never);
    const { integrations } = result.details as {
      integrations: Array<{ section: string }>;
    };
    assert.equal(integrations.length, CHAT_INTEGRATIONS.length);
  });
});
