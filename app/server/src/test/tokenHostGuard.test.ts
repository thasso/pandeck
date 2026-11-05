/**
 * The test token-host guard (`tokenHostGuard.ts`) refuses both renewers on
 * their production defaults: the gateway's Claude renewal with no endpoint
 * override, and pi's Codex refresh with the real `fetch`. Each case takes its
 * own refusals, so `setup.ts` does not fail it for them.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { HoldTable, WriterLane } from "../gateway/holds.ts";
import { LeaseTable } from "../gateway/leases.ts";
import { ProfileRegistry } from "../gateway/profiles.ts";
import { createRenewal } from "../gateway/renewal.ts";
import { renewCodexCredential } from "../piSdk/codexRenewal.ts";
import { TOKEN_HOST_REFUSED, takeTokenHostAttempts } from "./tokenHostGuard.ts";

const FAKE_ACCESS = "fake-guard-access";
const FAKE_REFRESH = "fake-guard-refresh";

test("https.request and fetch to a token host are refused before any lookup", async () => {
  const code = await new Promise<unknown>((resolve) => {
    const request = https.request({
      host: "platform.claude.com",
      method: "POST",
      path: "/v1/oauth/token",
      agent: false,
    });
    request.on("error", (err: NodeJS.ErrnoException) => resolve(err.code));
    request.end("{}");
  });
  assert.equal(code, TOKEN_HOST_REFUSED);
  await assert.rejects(
    fetch("https://auth.openai.com/oauth/token", { method: "POST" }),
    (err: Error) =>
      (err.cause as NodeJS.ErrnoException | undefined)?.code ===
      TOKEN_HOST_REFUSED,
  );
  assert.deepEqual(takeTokenHostAttempts(), [
    "platform.claude.com",
    "auth.openai.com",
  ]);
});

test("a Claude renewal with no endpoint override is refused at the real host, and nothing is written", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "guard-")), "claude");
  await mkdir(dir);
  const tokenFile = join(dir, ".credentials.json");
  const stored = JSON.stringify({
    claudeAiOauth: {
      accessToken: FAKE_ACCESS,
      refreshToken: FAKE_REFRESH,
      expiresAt: Date.now() - 60_000,
    },
  });
  await writeFile(tokenFile, stored);
  const profiles = new ProfileRegistry();
  profiles.upsert({
    id: "guarded",
    provider: "claude",
    name: "Guarded",
    enabled: true,
    tokenFile,
  });
  const leases = new LeaseTable();
  leases.grant(
    { profileId: "guarded", provider: "claude", tokenFile },
    { kind: "engine", owner: { workerId: "local", sessionId: "s1" } },
  );
  const lines: string[] = [];
  const renewal = createRenewal({
    profiles,
    leases,
    lane: new WriterLane(new HoldTable(), () => "claude"),
    log: (line) => lines.push(line),
    report: () => {},
  });
  try {
    assert.deepEqual(await renewal.renew("guarded"), {
      kind: "failed",
      code: TOKEN_HOST_REFUSED,
    });
  } finally {
    renewal.close();
  }
  assert.deepEqual(takeTokenHostAttempts(), ["platform.claude.com"]);
  assert.equal(await readFile(tokenFile, "utf8"), stored);
  assert.ok(lines.every((line) => !line.includes(FAKE_REFRESH)));
});

test("pi's Codex refresh with the real fetch is refused at the real host, and nothing is written", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guard-"));
  const authFile = join(dir, "auth.json");
  const stored = JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "fake-guard-codex-access",
      refresh: FAKE_REFRESH,
      accountId: "fake-guard-account",
      expires: Date.now() - 60_000,
    },
  });
  await writeFile(authFile, stored);
  const result = await renewCodexCredential(
    authFile,
    30 * 60_000,
    AbortSignal.timeout(10_000),
  );
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes(FAKE_REFRESH));
  assert.deepEqual(takeTokenHostAttempts(), ["auth.openai.com"]);
  assert.equal(await readFile(authFile, "utf8"), stored);
});
