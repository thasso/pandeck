import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { getSettings } from "../../settings.ts";
import { saveSettings } from "../../settingsService.ts";
import { settingsTools } from "./settingsTools.ts";

const [settingsRead, settingsUpdate] = settingsTools;

/** Fake stored values the scrubbing tests look for in tool output. */
const BRAVE_FIXTURE = "BRAVE_WRITEONLY_KEY_1";
const KEPT_FIXTURE = "STILL_CONFIGURED_KEY";

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

describe("nothing secret reaches the agent", () => {
  test("a test response echoing the stored key is scrubbed", async () => {
    await saveSettings({
      brave: { enabled: true, apiKey: BRAVE_FIXTURE },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`bad X-Subscription-Token: ${BRAVE_FIXTURE}`, {
            status: 401,
          }),
      ),
    );
    const result = await settingsUpdate!.execute(
      { test: ["web-search"] },
      {} as never,
    );
    const text = JSON.stringify(result);
    assert.equal(text.includes(BRAVE_FIXTURE), false);
    assert.match(text, /\[redacted\]/);
  });

  test("a Basic auth echo of email and token is scrubbed", async () => {
    await saveSettings({
      jira: {
        enabled: true,
        atlassianEmail: "me@example.com",
        atlassianToken: "JIRA_WRITEONLY_TOKEN",
      },
    });
    const basic = Buffer.from("me@example.com:JIRA_WRITEONLY_TOKEN").toString(
      "base64",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`denied ${basic}`, { status: 401 })),
    );
    const result = await settingsUpdate!.execute(
      { test: ["jira"] },
      {} as never,
    );
    const text = JSON.stringify(result);
    assert.equal(text.includes(basic), false);
    assert.equal(text.includes("JIRA_WRITEONLY_TOKEN"), false);
  });

  test("credentials in a URL are never read back", async () => {
    for (const baseUrl of [
      "https://alice:URL_PASSWORD_1@example.invalid/v1",
      "https://alice%40corp:URL%2FPASSWORD%3A2@example.invalid/v1",
    ]) {
      await saveSettings({ openAiCompatible: { baseUrl } });
      const result = await settingsRead!.execute(
        { paths: ["openAiCompatible.baseUrl"] },
        {} as never,
      );
      const text = JSON.stringify(result);
      assert.equal(
        /URL_PASSWORD_1|URL%2FPASSWORD|alice/.test(text),
        false,
        text,
      );
      assert.match(text, /https:\/\/\[redacted\]@example\.invalid\/v1/);
    }
  });

  test("a corrupt settings file never quotes its contents in an error", async () => {
    const { writeFileSync, rmSync, existsSync, renameSync } =
      await import("node:fs");
    const { join } = await import("node:path");
    const { DATA_DIR } = await import("../../config.ts");
    const path = join(DATA_DIR, "settings", "context7.json");
    const saved = `${path}.test-saved`;
    const hadFile = existsSync(path);
    if (hadFile) renameSync(path, saved);
    writeFileSync(path, '{"apiKey": "CORRUPT_FILE_SECRET" oops');
    try {
      await assert.rejects(
        settingsRead!.execute({ section: "context7" }, {} as never),
        (err: Error) =>
          /not valid JSON/.test(err.message) &&
          !err.message.includes("CORRUPT_FILE_SECRET"),
      );
    } finally {
      rmSync(path);
      if (hadFile) renameSync(saved, path);
    }
  });
});

describe("arguments are checked before anything changes", () => {
  test("an omitted value never clears or disconnects", async () => {
    await saveSettings({ brave: { apiKey: KEPT_FIXTURE } });
    for (const path of ["brave.apiKey", "google.connection"])
      await assert.rejects(
        call(settingsUpdate, { changes: [{ path }] }),
        /changes\[0\]\.value is required/,
      );
    assert.equal(getSettings().brave.apiKeyConfigured, true);
  });

  test("unknown fields, sections and malformed shapes are refused", async () => {
    const refuse = (
      tool: typeof settingsRead,
      params: unknown,
      pattern: RegExp,
    ) => assert.rejects(call(tool, params as Record<string, unknown>), pattern);
    await refuse(settingsRead, { section: "nope" }, /Unknown section: nope/);
    await refuse(settingsRead, { extra: 1 }, /unknown fields: extra/);
    await refuse(settingsRead, { paths: "memory.maxCards" }, /paths must be/);
    await refuse(
      settingsUpdate,
      { changes: [{ path: "sessionNaming.enabled", value: true, x: 1 }] },
      /changes\[0\] has unknown fields: x/,
    );
    await refuse(
      settingsUpdate,
      { test: ["about"] },
      /about has no connection test/,
    );
    await refuse(
      settingsUpdate,
      { changes: Array.from({ length: 51 }, () => ({ path: "a", value: 1 })) },
      /at most 50/,
    );
  });

  test("a section named twice is tested once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 401 })),
    );
    const { tests } = (await call(settingsUpdate, {
      test: ["context7", "context7"],
    })) as { tests: unknown[] };
    assert.equal(tests.length, 1);
  });

  test("a cancelled call writes nothing", async () => {
    const before = getSettings().sessionNaming.enabled;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      settingsUpdate!.execute(
        { changes: [{ path: "sessionNaming.enabled", value: !before }] },
        { signal: controller.signal } as never,
      ),
    );
    assert.equal(getSettings().sessionNaming.enabled, before);
  });
});
