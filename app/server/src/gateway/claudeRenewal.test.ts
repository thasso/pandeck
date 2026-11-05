/**
 * AC1–AC3: the Claude refresh request as CLI 2.1.316 sends it, against a fake
 * TLS `platform.claude.com`, and the compare-and-swap save into a temp
 * `.credentials.json`. Every token is a fake sentinel.
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, test } from "vitest";
import {
  startFakeUpstreams,
  type FakeUpstreams,
  type UpstreamResponder,
} from "../test/gatewayFixtures.ts";
import {
  refreshClaude,
  saveClaude,
  type ClaudeTokens,
  type TokenEndpoint,
} from "./claudeRenewal.ts";

// Synthetic fixture values; none is a real credential.
const STORED_ACCESS = "fake-claude-old-access";
const STORED_REFRESH = "fake-claude-refresh-sentinel";
const NEW_ACCESS = "fake-claude-new-access-sentinel";
const NEW_REFRESH = "fake-claude-new-refresh-sentinel";

let upstreams: FakeUpstreams;
let respond: UpstreamResponder;

beforeAll(async () => {
  upstreams = await startFakeUpstreams({
    claudeToken: (seen, res) => respond(seen, res),
  });
});

afterAll(async () => {
  await upstreams.close();
});

function answer(
  status: number,
  body: unknown,
  headers = {},
): UpstreamResponder {
  return (_seen, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

const OK_BODY = {
  access_token: NEW_ACCESS,
  refresh_token: NEW_REFRESH,
  expires_in: 28_800,
  scope: "user:inference user:profile",
  refresh_token_expires_in: 2_592_000,
  token_type: "Bearer",
};

async function refresh(
  stored: { refreshToken: string; scopes?: unknown } = {
    refreshToken: STORED_REFRESH,
  },
  endpoint: TokenEndpoint = upstreams.tokenEndpoint,
  timeoutMs?: number,
) {
  upstreams.platform.length = 0;
  return refreshClaude(
    stored,
    endpoint,
    new AbortController().signal,
    timeoutMs,
  );
}

test("AC1: the request is the CLI's: method, path, Host, the four fields, axios headers, nothing else", async () => {
  respond = answer(200, OK_BODY);
  const result = await refresh({
    refreshToken: STORED_REFRESH,
    scopes: ["user:inference", "user:profile"],
  });
  assert.deepEqual(result, {
    kind: "ok",
    tokens: {
      accessToken: NEW_ACCESS,
      refreshToken: NEW_REFRESH,
      expiresInS: 28_800,
      scope: "user:inference user:profile",
      refreshTokenExpiresInS: 2_592_000,
    },
  });
  assert.equal(upstreams.platform.length, 1);
  const [seen] = upstreams.platform;
  assert.equal(seen!.method, "POST");
  assert.equal(seen!.url, "/v1/oauth/token");
  assert.deepEqual(JSON.parse(seen!.body.toString("utf8")), {
    grant_type: "refresh_token",
    refresh_token: STORED_REFRESH,
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    scope: "user:inference user:profile",
  });
  const { headers } = seen!;
  assert.equal(headers.host, "platform.claude.com");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.accept, "application/json, text/plain, */*");
  assert.equal(headers["user-agent"], "axios/1.15.2");
  assert.equal(headers["anthropic-beta"], undefined);
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
});

test("AC1: without stored scopes the CLI's default scopes are sent", async () => {
  respond = answer(200, OK_BODY);
  for (const scopes of [undefined, [], "not-a-list"]) {
    await refresh({ refreshToken: STORED_REFRESH, scopes });
    assert.equal(
      JSON.parse(upstreams.platform[0]!.body.toString("utf8")).scope,
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
  }
});

test("AC1: a redirect is not followed", async () => {
  respond = answer(302, "", { location: "https://elsewhere.example/steal" });
  assert.deepEqual(await refresh(), { kind: "failed", code: "redirect" });
  assert.equal(upstreams.platform.length, 1);
});

test("AC1: a response trickling past the deadline fails with timeout", async () => {
  respond = (_seen, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => res.write(" "), 20);
    res.on("close", () => clearInterval(timer));
  };
  const started = Date.now();
  assert.deepEqual(await refresh(undefined, undefined, 300), {
    kind: "failed",
    code: "timeout",
  });
  assert.ok(Date.now() - started < 2_000);
});

test("AC1/AC10: outcomes name a status, an errno or a fixed word, never the body", async () => {
  const cases: [UpstreamResponder, unknown][] = [
    [
      answer(400, {
        error: "invalid_grant",
        error_description: STORED_REFRESH,
      }),
      { kind: "rejected" },
    ],
    [answer(401, { error: "invalid_grant" }), { kind: "rejected" }],
    [
      answer(400, { error: "invalid_request", detail: STORED_REFRESH }),
      { kind: "failed", code: "400" },
    ],
    [answer(403, { error: "invalid_grant" }), { kind: "failed", code: "403" }],
    [answer(503, STORED_REFRESH), { kind: "failed", code: "503" }],
    [
      answer(200, { ...OK_BODY, expires_in: undefined }),
      { kind: "failed", code: "bad_response" },
    ],
    [
      answer(200, { ...OK_BODY, expires_in: 0 }),
      { kind: "failed", code: "bad_response" },
    ],
    [
      answer(200, { ...OK_BODY, expires_in: 31_536_001 }),
      { kind: "failed", code: "bad_response" },
    ],
    [
      answer(200, { ...OK_BODY, access_token: "has space" }),
      { kind: "failed", code: "bad_response" },
    ],
    [
      answer(200, { ...OK_BODY, refresh_token: 7 }),
      { kind: "failed", code: "bad_response" },
    ],
    [
      answer(200, { ...OK_BODY, scope: ["x"] }),
      { kind: "failed", code: "bad_response" },
    ],
    [answer(200, "not json"), { kind: "failed", code: "bad_response" }],
  ];
  for (const [responder, expected] of cases) {
    respond = responder;
    assert.deepEqual(await refresh(), expected);
  }
  const closed = {
    connect: { host: "127.0.0.1", port: 1 },
    ca: upstreams.tokenEndpoint.ca,
  };
  assert.deepEqual(await refresh(undefined, closed), {
    kind: "failed",
    code: "ECONNREFUSED",
  });
});

test("AC1: an omitted refresh token or refresh expiry stays absent in the result", async () => {
  respond = answer(200, {
    access_token: NEW_ACCESS,
    expires_in: 3600,
    refresh_token_expires_in: "2592000",
  });
  assert.deepEqual(await refresh(), {
    kind: "ok",
    tokens: {
      accessToken: NEW_ACCESS,
      refreshToken: undefined,
      expiresInS: 3600,
      scope: undefined,
      refreshTokenExpiresInS: undefined,
    },
  });
});

test.each([
  ["absent", undefined],
  ["zero", 0],
  ["negative", -1],
  ["null", null],
  ["a string", "2592000"],
])(
  "AC2: a refresh expiry that is %s is left out, and the response still counts",
  async (_name, value) => {
    respond = answer(200, {
      access_token: NEW_ACCESS,
      refresh_token: NEW_REFRESH,
      expires_in: 3600,
      ...(value === undefined ? {} : { refresh_token_expires_in: value }),
    });
    const result = await refresh();
    assert.equal(result.kind, "ok");
    assert.equal(
      result.kind === "ok" ? result.tokens.refreshTokenExpiresInS : "none",
      undefined,
    );
  },
);

const NOW = 1_800_000_000_000;

function tokens(overrides: Partial<ClaudeTokens> = {}): ClaudeTokens {
  return {
    accessToken: NEW_ACCESS,
    refreshToken: NEW_REFRESH,
    expiresInS: 28_800,
    scope: "user:inference user:profile",
    refreshTokenExpiresInS: 2_592_000,
    ...overrides,
  };
}

const STORED = {
  claudeAiOauth: {
    accessToken: STORED_ACCESS,
    refreshToken: STORED_REFRESH,
    expiresAt: NOW - 1000,
    refreshTokenExpiresAt: NOW + 1000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    clientId: "fixture-client",
  },
  mcpOAuth: { server: { accessToken: "fake-mcp" } },
  organizationUuid: "org-fixture",
};

async function credentialsFile(doc: unknown = STORED): Promise<{
  dir: string;
  file: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "claude-save-"));
  const file = join(dir, ".credentials.json");
  await writeFile(file, JSON.stringify(doc), { mode: 0o600 });
  return { dir, file };
}

test("AC2: a save keeps every other key, replaces the tokens, 0600, a new inode, no temp left", async () => {
  const { dir, file } = await credentialsFile();
  const before = await stat(file);
  assert.deepEqual(saveClaude(file, STORED_REFRESH, tokens(), NOW), {
    kind: "renewed",
  });
  const after = await stat(file);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), [".credentials.json"]);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, {
    ...STORED,
    claudeAiOauth: {
      ...STORED.claudeAiOauth,
      accessToken: NEW_ACCESS,
      refreshToken: NEW_REFRESH,
      expiresAt: NOW + 28_800_000,
      refreshTokenExpiresAt: NOW + 2_592_000_000,
      scopes: ["user:inference", "user:profile"],
    },
  });
});

test("AC2: an omitted refresh token, scope or refresh expiry keeps the stored one", async () => {
  const { file } = await credentialsFile();
  saveClaude(
    file,
    STORED_REFRESH,
    tokens({
      refreshToken: undefined,
      scope: undefined,
      refreshTokenExpiresInS: undefined,
    }),
    NOW,
  );
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    ...STORED,
    claudeAiOauth: {
      ...STORED.claudeAiOauth,
      accessToken: NEW_ACCESS,
      expiresAt: NOW + 28_800_000,
    },
  });
});

test("AC2: a symlinked token file stays a symlink, its target updated", async () => {
  const { dir, file } = await credentialsFile();
  const linkDir = await mkdtemp(join(tmpdir(), "claude-link-"));
  const link = join(linkDir, ".credentials.json");
  await symlink(file, link);
  assert.equal(saveClaude(link, STORED_REFRESH, tokens(), NOW).kind, "renewed");
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readlink(link), file);
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).claudeAiOauth.accessToken,
    NEW_ACCESS,
  );
  assert.deepEqual(readdirSync(dir), [".credentials.json"]);
  assert.deepEqual(readdirSync(linkDir), [".credentials.json"]);
});

test("AC2: a rename that throws leaves the old file byte-identical and no temp", async () => {
  const { dir, file } = await credentialsFile();
  const bytes = await readFile(file);
  const result = saveClaude(file, STORED_REFRESH, tokens(), NOW, () => {
    throw Object.assign(new Error("injected"), { code: "EIO" });
  });
  assert.deepEqual(result, { kind: "failed", code: "EIO" });
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(readdirSync(dir), [".credentials.json"]);
});

test("AC2: a leftover temp older than a minute is removed, a newer one kept", async () => {
  const { dir, file } = await credentialsFile();
  const old = join(dir, ".credentials.json.pandeck-00000000000000aa.tmp");
  const fresh = join(dir, ".credentials.json.pandeck-00000000000000bb.tmp");
  await writeFile(old, "x");
  await writeFile(fresh, "x");
  const at = new Date(Date.now() - 61_000);
  await utimes(old, at, at);
  saveClaude(file, STORED_REFRESH, tokens(), Date.now());
  assert.deepEqual(readdirSync(dir).sort(), [
    ".credentials.json",
    ".credentials.json.pandeck-00000000000000bb.tmp",
  ]);
});

test("AC2: a removed profile dir is gone, and nothing is created", async () => {
  const { dir, file } = await credentialsFile();
  await rm(dir, { recursive: true });
  assert.deepEqual(saveClaude(file, STORED_REFRESH, tokens(), NOW), {
    kind: "failed",
    code: "gone",
  });
  await assert.rejects(stat(dir));
});

test("AC3: another refresh token in the file is adopted, byte-identical", async () => {
  const { file } = await credentialsFile({
    ...STORED,
    claudeAiOauth: {
      ...STORED.claudeAiOauth,
      refreshToken: "fake-other-login",
    },
  });
  const bytes = await readFile(file);
  const before = await stat(file);
  assert.deepEqual(saveClaude(file, STORED_REFRESH, tokens(), NOW), {
    kind: "adopted",
  });
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).ino, before.ino);
});

test("AC3: a blank refresh token is written over; a missing claudeAiOauth is not", async () => {
  const blank = await credentialsFile({
    ...STORED,
    claudeAiOauth: { ...STORED.claudeAiOauth, refreshToken: "" },
  });
  assert.equal(
    saveClaude(blank.file, STORED_REFRESH, tokens(), NOW).kind,
    "renewed",
  );
  assert.equal(
    JSON.parse(await readFile(blank.file, "utf8")).claudeAiOauth.refreshToken,
    NEW_REFRESH,
  );
  const none = await credentialsFile({ organizationUuid: "org-fixture" });
  const bytes = await readFile(none.file);
  assert.deepEqual(saveClaude(none.file, STORED_REFRESH, tokens(), NOW), {
    kind: "adopted",
  });
  assert.deepEqual(await readFile(none.file), bytes);
});

test("AC16: no failure names a token", async () => {
  respond = answer(400, { error: "invalid_request", token: STORED_REFRESH });
  const failed = await refresh();
  const { file } = await credentialsFile();
  const saved = saveClaude(file, STORED_REFRESH, tokens(), NOW, () => {
    throw new Error(`cannot rename ${NEW_ACCESS}`);
  });
  for (const value of [failed, saved]) {
    const text = JSON.stringify(value);
    for (const sentinel of [STORED_REFRESH, NEW_ACCESS, NEW_REFRESH])
      assert.ok(!text.includes(sentinel), text);
  }
});
