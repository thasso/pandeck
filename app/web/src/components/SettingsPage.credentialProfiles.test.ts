import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { CredentialProfileSummary } from "@assistant/shared";
import {
  CredentialProfileCard,
  credentialProfilesForProvider,
} from "./SettingsPage.tsx";

const profiles = [
  {
    id: "claude-default",
    name: "Claude",
    provider: "claude",
    enabled: true,
    status: "ready",
  },
  {
    id: "default",
    name: "OpenAI",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
  },
  {
    id: "openai-work",
    name: "OpenAI work",
    provider: "openai-codex",
    enabled: true,
    status: "disconnected",
  },
] as CredentialProfileSummary[];

describe("credential profile settings", () => {
  test("keeps Claude and OpenAI profile pages isolated", () => {
    expect(
      credentialProfilesForProvider(profiles, "claude").map(
        (profile) => profile.id,
      ),
    ).toEqual(["claude-default"]);
    expect(
      credentialProfilesForProvider(profiles, "openai-codex").map(
        (profile) => profile.id,
      ),
    ).toEqual(["default", "openai-work"]);
  });

  test("keeps rename and delete as icon-only top actions and gives reconnect an icon", () => {
    const profile = {
      ...profiles[0]!,
      id: "claude-private",
      name: "Claude private",
    };
    const html = renderToStaticMarkup(
      createElement(CredentialProfileCard, {
        profile,
        providerLabel: "Claude",
        connectionLabel: "Reconnect",
        onToggle: () => {},
        onConnect: () => {},
        onRename: () => {},
        onDelete: () => {},
      }),
    );
    expect(html).toContain('aria-label="Rename Claude private"');
    expect(html).toContain('aria-label="Delete Claude private"');
    expect(html).not.toContain(">Rename<");
    expect(html).not.toContain(">Delete<");
    expect(html).toMatch(
      /<svg[^>]*>[\s\S]*?<\/svg><span class="truncate">Reconnect<\/span>/,
    );
    expect(html.indexOf('aria-label="Rename Claude private"')).toBeLessThan(
      html.indexOf('role="switch"'),
    );
  });
});
