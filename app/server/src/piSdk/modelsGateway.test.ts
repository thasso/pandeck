/**
 * C13 (Task-1368 AC2): with the gateway on, the server's own pi runtimes keep
 * their Codex catalog but never ask the token host or write `auth.json`. Real
 * pi runtimes, fake expired logins, `fetch` stubbed: nothing leaves.
 */
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, test, vi } from "vitest";

let gatewayOn = true;
vi.mock("../config.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.ts")>();
  return {
    ...actual,
    get GATEWAY_ENABLED() {
      return gatewayOn;
    },
  };
});

/** Every request pi made, as `METHOD host/path`. */
const sent: string[] = [];
vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  sent.push(`${method} ${url.host}${url.pathname}`);
  // The token host refuses, so even a control refresh writes nothing.
  return Promise.resolve(
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
  );
});
afterAll(() => vi.unstubAllGlobals());

const TOKEN_REQUEST = "POST auth.openai.com/oauth/token";
const CATALOG_REQUEST = "GET pi.dev/api/models/providers/openai-codex";

const { createCredentialProfile, piAgentDir } =
  await import("../credentialProfiles.ts");

/** An expired fake Codex login. */
function expiredLogin(profileId: string): string {
  const path = join(piAgentDir(profileId), "auth.json");
  writeFileSync(
    path,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: Date.now() - 60_000,
        accountId: "fixture-account",
      },
    }),
  );
  return path;
}

function snapshot(path: string): { ino: number; bytes: string } {
  return { ino: statSync(path).ino, bytes: readFileSync(path, "utf8") };
}

const files = [
  expiredLogin("default"),
  expiredLogin(
    createCredentialProfile({ name: "Second", provider: "openai-codex" }).id,
  ),
  expiredLogin(
    createCredentialProfile({ name: "Third", provider: "openai-codex" }).id,
  ),
];
const before = files.map(snapshot);

// Module load creates the default runtime.
const {
  availableModelsForProfile,
  modelRuntimeForProfile,
  refreshModels,
  warmCredentialProfileModelRuntimes,
} = await import("./models.ts");
const { listCredentialProfiles } = await import("../credentialProfiles.ts");

test("AC2: creation, warm-up and the forced refresh never ask the token host", async () => {
  await warmCredentialProfileModelRuntimes();
  await refreshModels();
  assert.ok(
    !sent.includes(TOKEN_REQUEST),
    `no token request: ${sent.join(", ")}`,
  );
  assert.ok(sent.includes(CATALOG_REQUEST), "the Codex catalog is fetched");
  assert.deepEqual(files.map(snapshot), before, "every auth.json untouched");
  for (const profile of listCredentialProfiles().filter(
    (p) => p.provider === "openai-codex",
  )) {
    const codex = (await availableModelsForProfile(profile.id)).filter(
      (model) => model.provider === "openai-codex",
    );
    assert.ok(codex.length > 0, `${profile.name} keeps its Codex models`);
  }
});

test("AC2 control: a runtime made with the switch off refreshes the expired login", async () => {
  gatewayOn = false;
  try {
    const id = createCredentialProfile({
      name: "Control",
      provider: "openai-codex",
    }).id;
    expiredLogin(id);
    await modelRuntimeForProfile(id);
    sent.length = 0;
    await refreshModels();
    assert.ok(
      sent.includes(TOKEN_REQUEST),
      `the control's refresh is visible: ${sent.join(", ")}`,
    );
  } finally {
    gatewayOn = true;
  }
});
