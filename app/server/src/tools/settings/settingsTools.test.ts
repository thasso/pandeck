import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { getSettings } from "../../settings.ts";
import {
  onSettingsChanged,
  saveSettings,
  type SettingsChange,
} from "../../settingsService.ts";
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
      /secret values never pass through an agent\. Ask the user for it with settings_request_input/,
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
  test("moving an integration to another host clears its token before any test sends it", async () => {
    await saveSettings({
      forgejo: {
        enabled: true,
        baseUrl: "https://git.example.com",
        token: "tok-held",
      },
    });
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        sent.push(JSON.stringify(init?.headers ?? {}));
        return new Response(JSON.stringify({ version: "1.0" }), {
          status: 200,
        });
      }),
    );
    try {
      const result = await call(settingsUpdate, {
        changes: [{ path: "forgejo.baseUrl", value: "https://evil.test" }],
        test: ["forgejo"],
      });
      assert.deepEqual(
        (result.credentialsCleared as Array<{ path: string }>).map(
          (c) => c.path,
        ),
        ["forgejo.token"],
      );
      assert.ok(sent.length > 0, "the connection test ran");
      assert.equal(
        sent.some((headers) => headers.includes("tok-held")),
        false,
      );
      const same = await call(settingsUpdate, {
        changes: [{ path: "forgejo.baseUrl", value: "https://evil.test/git" }],
      });
      assert.equal("credentialsCleared" in same, false);
    } finally {
      await saveSettings({
        forgejo: { enabled: false, baseUrl: "", clearToken: true },
      });
    }
  });

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
    // A failure is told in the server's words, never the endpoint's.
    assert.match(
      text,
      /The web-search connection test failed with HTTP 401\. The Settings page shows the details: \/settings\/web-search\./,
    );
    assert.equal(text.includes("X-Subscription-Token"), false);
  });

  test("a key too short to scrub from ordinary text is never echoed", async () => {
    await saveSettings({ brave: { enabled: true, apiKey: "privkey" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad key: privkey", { status: 401 })),
    );
    const text = JSON.stringify(
      await settingsUpdate!.execute({ test: ["web-search"] }, {} as never),
    );
    assert.equal(text.includes("privkey"), false);
  });

  test("a key replaced while its test is out is never echoed", async () => {
    const oldKey = "OLD_FIXTURE_BRAVE_VALUE";
    const newKey = "NEW_FIXTURE_BRAVE_VALUE";
    await saveSettings({ brave: { enabled: true, apiKey: oldKey } });
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(`denied ${oldKey}`, { status: 401 });
      }),
    );
    const pending = settingsUpdate!.execute(
      { test: ["web-search"] },
      {} as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await saveSettings({ brave: { apiKey: newKey } });
    release();
    assert.equal(JSON.stringify(await pending).includes(oldKey), false);
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
      // An unescaped `@` in the password: userinfo ends at the last one.
      "https://alice:URL_PASSWORD_1@URL_PASSWORD_TAIL@example.invalid/v1",
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

describe("a cancelled or overtaken test changes nothing", () => {
  /** A fetch that waits for `release`, and rejects like the real one on abort. */
  function gatedFetch(body: unknown) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("This operation was aborted")),
        );
      });
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { fetch, release: () => release() };
  }

  test("cancelling discovery mid-request keeps a change saved after it", async () => {
    await saveSettings({
      openAiCompatible: {
        enabled: true,
        baseUrl: "http://models.invalid/v1",
      },
    });
    const { fetch, release } = gatedFetch({ data: [{ id: "late-model" }] });
    vi.stubGlobal("fetch", fetch);
    const heard: SettingsChange[] = [];
    const stopListening = onSettingsChanged((change) => heard.push(change));
    const controller = new AbortController();
    const pending = settingsUpdate!.execute({ test: ["openai-compatible"] }, {
      signal: controller.signal,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopListening();
    // Nothing was stored, so nothing was announced.
    assert.deepEqual(heard, []);
    await saveSettings({ openAiCompatible: { enabled: false } });
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const { openAiCompatible } = getSettings();
    assert.equal(openAiCompatible.enabled, false);
    assert.equal(
      openAiCompatible.models.some((m) => m.id === "late-model"),
      false,
    );
  });

  test("discovery overtaken by a new endpoint stores nothing", async () => {
    await saveSettings({
      openAiCompatible: {
        enabled: true,
        baseUrl: "http://old-models.invalid/v1",
      },
    });
    const { fetch, release } = gatedFetch({ data: [{ id: "stale-model" }] });
    vi.stubGlobal("fetch", fetch);
    const pending = settingsUpdate!.execute(
      { test: ["openai-compatible"] },
      {} as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await saveSettings({
      openAiCompatible: { baseUrl: "http://new-models.invalid/v1" },
    });
    release();
    const { tests } = (await pending).details as {
      tests: Array<{ ok: boolean }>;
    };
    assert.equal(tests[0]?.ok, false);
    const { openAiCompatible } = getSettings();
    assert.equal(openAiCompatible.baseUrl, "http://new-models.invalid/v1");
    assert.equal(
      openAiCompatible.models.some((m) => m.id === "stale-model"),
      false,
    );
  });
});
