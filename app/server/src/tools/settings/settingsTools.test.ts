import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { getSettings } from "../../settings.ts";
import { saveSettings } from "../../settingsService.ts";
import { settingsTools } from "./settingsTools.ts";

const [settingsRead, settingsUpdate] = settingsTools;

async function call(
  tool: (typeof settingsTools)[number] | undefined,
  params: Record<string, unknown>,
) {
  const result = await tool!.execute(params, {} as never);
  return result.details as Record<string, unknown>;
}

type Entry = {
  path: string;
  access: string;
  type?: string;
  value?: unknown;
  configured?: boolean;
  connected?: boolean;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings_read", () => {
  test("with no arguments, lists every section", async () => {
    const { sections } = (await call(settingsRead, {})) as {
      sections: Array<{ section: string; settings: number }>;
    };
    const naming = sections.find((s) => s.section === "naming");
    assert.ok(naming && naming.settings > 0);
    const about = sections.find((s) => s.section === "about") as
      { notInSettingsTools?: string } | undefined;
    assert.ok(about?.notInSettingsTools, "a section without settings says why");
  });

  test("a section reports each setting's value, type and access", async () => {
    const { settings } = (await call(settingsRead, {
      section: "memory",
    })) as { settings: Entry[] };
    const maxCards = settings.find((e) => e.path === "memory.maxCards");
    assert.deepEqual(
      maxCards && { ...maxCards, value: typeof maxCards.value },
      {
        path: "memory.maxCards",
        label: "Cards per turn",
        access: "value",
        type: "integer 1–32",
        value: "number",
      },
    );
  });

  test("a secret reports only whether it is set", async () => {
    await saveSettings({ github: { token: "ghp_never_shown" } });
    const result = await settingsRead!.execute(
      { section: "github" },
      {} as never,
    );
    const text = JSON.stringify(result);
    assert.equal(text.includes("ghp_never_shown"), false);
    const token = (result.details as { settings: Entry[] }).settings.find(
      (e) => e.path === "github.token",
    );
    assert.equal(token?.configured, true);
    assert.equal("value" in token!, false);
  });

  test("refuses an unknown path", async () => {
    await assert.rejects(
      call(settingsRead, { paths: ["nope.never"] }),
      /Unknown setting path: nope\.never/,
    );
  });
});

describe("settings_update", () => {
  test("writes a field and reads back what was stored", async () => {
    const { saved } = (await call(settingsUpdate, {
      changes: [{ path: "sessionNaming.enabled", value: false }],
    })) as { saved: Entry[] };
    assert.equal(saved[0]?.value, false);
    assert.equal(getSettings().sessionNaming.enabled, false);
  });

  test("never accepts a secret's value", async () => {
    await assert.rejects(
      call(settingsUpdate, {
        changes: [{ path: "jira.atlassianToken", value: "secret" }],
      }),
      /secret values never pass through an agent.*\/settings\/jira/,
    );
    assert.equal(getSettings().jira.atlassianTokenConfigured, false);
  });

  test("null clears a secret", async () => {
    await saveSettings({ brave: { apiKey: "key" } });
    const { saved } = (await call(settingsUpdate, {
      changes: [{ path: "brave.apiKey", value: null }],
    })) as { saved: Entry[] };
    assert.equal(saved[0]?.configured, false);
  });

  test("says when the assistant's own profile changed, and only then", async () => {
    const name = getSettings().permanentAssistant.name;
    const same = await call(settingsUpdate, {
      changes: [{ path: "permanentAssistant.name", value: name }],
    });
    assert.equal("assistantRestart" in same, false);
    const renamed = await call(settingsUpdate, {
      changes: [{ path: "permanentAssistant.name", value: "Larry" }],
    });
    assert.match(String(renamed.assistantRestart), /fresh session/);
    assert.equal(getSettings().permanentAssistant.name, "Larry");
  });

  test("runs a connection test after saving", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const { tests } = (await call(settingsUpdate, {
      changes: [{ path: "github.enabled", value: true }],
      test: ["github"],
    })) as { tests: Array<{ section: string; ok: boolean }> };
    assert.equal(tests[0]?.section, "github");
    assert.equal(typeof tests[0]?.ok, "boolean");
  });

  test("refuses an empty call", async () => {
    await assert.rejects(call(settingsUpdate, {}), /at least one change/);
  });
});
