import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, test, vi } from "vitest";
import type { ApprovalCard } from "@assistant/shared";
import { setAgentHandoffDeliveryStoppedForTests } from "./agentHandoffs.ts";
import { DATA_DIR } from "./config.ts";
import {
  approvalForId,
  approvalsForSession,
  createApproval,
  resolveApproval,
} from "./pendingApprovals.ts";
import { getSettings } from "./settings.ts";
import { announceSettingsWritten } from "./settingsService.ts";
import "./settingsInput.ts";
import { settingsTools } from "./tools/settings/settingsTools.ts";

const requestInput = settingsTools.find(
  (tool) => tool.name === "settings_request_input",
)!;

/** A fake token the tests look for everywhere it must not be. */
const TYPED_FIXTURE = "typed-fixture-value-for-card";

function ctx(sessionId: string) {
  return {
    toolCallId: `call-${sessionId}`,
    session: { sessionId },
  } as never;
}

async function raise(sessionId: string, path: string): Promise<ApprovalCard> {
  const result = await requestInput.execute({ path }, ctx(sessionId));
  assert.equal(result.terminate, true, "the turn ends on a raised card");
  const card = approvalsForSession(sessionId).find(
    (c) => c.status === "pending" && c.body.kind === "settingsInput",
  );
  assert.ok(card, "a pending settings-input card exists");
  return card;
}

beforeAll(() => setAgentHandoffDeliveryStoppedForTests(true));
afterAll(() => setAgentHandoffDeliveryStoppedForTests(false));
afterEach(() => vi.unstubAllGlobals());

describe("settings_request_input", () => {
  test("raises a card that names the setting and carries no value", async () => {
    const card = await raise("s-raise", "github.token");
    assert.deepEqual(card.body, {
      kind: "settingsInput",
      path: "github.token",
      label: "Personal access token",
      section: "github",
      mode: "secret",
      wasConfigured: false,
    });
    assert.equal(card.title, "Enter Personal access token");
  });

  test("asking again replaces the earlier card", async () => {
    const first = await raise("s-again", "brave.apiKey");
    const second = await raise("s-again", "brave.apiKey");
    assert.notEqual(first.id, second.id);
    assert.equal(approvalForId(first.id)?.status, "superseded");
  });

  test("refuses a setting that is not a secret or a connection", async () => {
    await assert.rejects(
      requestInput.execute({ path: "sessionNaming.enabled" }, ctx("s-no")),
      /not a secret or a connection; change it with settings_update/,
    );
    await assert.rejects(
      requestInput.execute({ path: "nope.never" }, ctx("s-no")),
      /Unknown setting path/,
    );
  });

  test("refuses a connection the deployment has no OAuth client for", async () => {
    // The test deployment configures no Google client secret.
    assert.equal(getSettings().google.oauthClientConfigured, false);
    await assert.rejects(
      requestInput.execute({ path: "google.connection" }, ctx("s-oauth")),
      /no OAuth client for it/,
    );
  });
});

describe("answering a secret card", () => {
  test("an approve without the value is refused and the card stays", async () => {
    const card = await raise("s-empty", "github.token");
    await assert.rejects(
      resolveApproval(card.id, "approved"),
      /Type the value into the card/,
    );
    await assert.rejects(
      resolveApproval(card.id, "approved", {
        kind: "settingsInput",
        value: "   ",
      }),
      /Type the value into the card/,
    );
    assert.equal(approvalForId(card.id)?.status, "pending");
  });

  test("saves the value, runs the test, and stores it nowhere else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(`bad credentials ${TYPED_FIXTURE}`, { status: 401 }),
      ),
    );
    await import("./settingsService.ts").then(({ saveSettings }) =>
      saveSettings({ github: { enabled: true } }),
    );
    const card = await raise("s-save", "github.token");
    const { card: done, outcomePrompt } = await resolveApproval(
      card.id,
      "approved",
      { kind: "settingsInput", value: `  ${TYPED_FIXTURE}  ` },
    );
    assert.equal(done.status, "executed");
    assert.equal(getSettings().github.tokenConfigured, true);
    assert.match(
      done.resultSummary ?? "",
      /Personal access token saved\. The github connection test failed with HTTP 401/,
    );
    // Not in the stored card, the outcome the agent reads, or the session's cards.
    for (const text of [
      JSON.stringify(approvalForId(card.id)),
      outcomePrompt,
      JSON.stringify(approvalsForSession("s-save")),
    ])
      assert.equal(text.includes(TYPED_FIXTURE), false);
  });

  test("a rejected card saves nothing", async () => {
    const before = getSettings().brave.apiKeyConfigured;
    const card = await raise("s-reject", "brave.apiKey");
    const { card: done } = await resolveApproval(card.id, "rejected");
    assert.equal(done.status, "rejected");
    assert.equal(getSettings().brave.apiKeyConfigured, before);
  });
});

describe("a connection card", () => {
  function raiseConnect(sessionId: string): ApprovalCard {
    // Created directly: the tool refuses without a deployment OAuth client.
    return createApproval({
      sessionId,
      kind: "settingsInput",
      title: "Connect Google account connection",
      body: {
        kind: "settingsInput",
        path: "google.connection",
        label: "Google account connection",
        section: "google",
        mode: "connect",
        wasConfigured: false,
      },
    });
  }

  test("cannot be approved before the account is connected", async () => {
    const card = raiseConnect("s-early");
    await assert.rejects(
      resolveApproval(card.id, "approved"),
      /not connected yet/,
    );
    assert.equal(approvalForId(card.id)?.status, "pending");
  });

  test("resolves itself when the OAuth callback stores the grant", async () => {
    const card = raiseConnect("s-connect");
    mkdirSync(join(DATA_DIR, "settings"), { recursive: true });
    writeFileSync(
      join(DATA_DIR, "settings", "google.json"),
      JSON.stringify({ enabled: true, refreshToken: "rt-fixture" }),
    );
    await announceSettingsWritten(["google"]);
    await vi.waitFor(() =>
      assert.equal(approvalForId(card.id)?.status, "executed"),
    );
    assert.match(
      approvalForId(card.id)?.resultSummary ?? "",
      /Google account connection: connected\./,
    );
  });
});

describe("nothing outlives or leaks from a secret card", () => {
  test("a side effect failing with the value in it reaches no card or outcome", async () => {
    const { subscribeIntegrationToolChanges } =
      await import("./integrationToolChanges.ts");
    const encoded = Buffer.from(TYPED_FIXTURE).toString("base64");
    const stop = subscribeIntegrationToolChanges(() => {
      throw new Error(`subscriber saw ${encoded}`);
    });
    try {
      const card = await raise("s-effect", "brave.apiKey");
      const { card: done, outcomePrompt } = await resolveApproval(
        card.id,
        "approved",
        { kind: "settingsInput", value: TYPED_FIXTURE },
      );
      assert.equal(done.status, "executed");
      assert.match(
        done.resultSummary ?? "",
        /Brave API key saved, but applying it did not complete everywhere\./,
      );
      for (const text of [
        JSON.stringify(approvalForId(card.id)),
        outcomePrompt,
      ]) {
        assert.equal(text.includes(encoded), false);
        assert.equal(text.includes(TYPED_FIXTURE), false);
      }
    } finally {
      stop();
    }
  });

  test("a failed write is reported in the server's words", async () => {
    const { existsSync, renameSync, rmdirSync } = await import("node:fs");
    const path = join(DATA_DIR, "settings", "context7.json");
    const saved = `${path}.test-saved`;
    // Raised first: raising reads every settings file.
    const card = await raise("s-fail", "context7.apiKey");
    const hadFile = existsSync(path);
    if (hadFile) renameSync(path, saved);
    // A directory where the file belongs makes the writer throw.
    mkdirSync(path, { recursive: true });
    try {
      const { card: done, outcomePrompt } = await resolveApproval(
        card.id,
        "approved",
        { kind: "settingsInput", value: TYPED_FIXTURE },
      );
      assert.equal(done.status, "failed");
      assert.equal(
        done.error,
        "Saving Context7 API key failed. The Settings page shows its state: /settings/context7.",
      );
      assert.equal(outcomePrompt.includes(TYPED_FIXTURE), false);
    } finally {
      rmdirSync(path);
      if (hadFile) renameSync(saved, path);
    }
  });

  test("a resolution stopped between prepare and execute drops the value", async () => {
    const { setApprovalBroadcastForTests } =
      await import("./pendingApprovals.ts");
    const { heldSecretCountForTests } = await import("./settingsInput.ts");
    const card = await raise("s-stopped", "brave.apiKey");
    setApprovalBroadcastForTests((_session, approval) => {
      if (approval.status === "executing") throw new Error("broadcast failed");
    });
    try {
      await assert.rejects(
        resolveApproval(card.id, "approved", {
          kind: "settingsInput",
          value: TYPED_FIXTURE,
        }),
        /broadcast failed/,
      );
    } finally {
      setApprovalBroadcastForTests(null);
    }
    assert.equal(heldSecretCountForTests(), 0);
  });
});

test("an unreadable unrelated file never breaks the connection listener", async () => {
  const { existsSync, renameSync, rmSync } = await import("node:fs");
  const { saveSettings } = await import("./settingsService.ts");
  const path = join(DATA_DIR, "settings", "slack.json");
  const saved = `${path}.test-saved`;
  const hadFile = existsSync(path);
  if (hadFile) renameSync(path, saved);
  writeFileSync(path, "{ not json");
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    // No connection card waits: the listener reads nothing. The save itself
    // reports the unreadable file once its write has landed.
    await saveSettings({
      browserTools: { headed: true, rawMcpEnabled: false },
    }).catch(() => {});
    // One waits on Google: the full read fails, and is reported, not thrown.
    createApproval({
      sessionId: "s-unreadable",
      kind: "settingsInput",
      title: "Connect Google account connection",
      body: {
        kind: "settingsInput",
        path: "google.connection",
        label: "Google account connection",
        section: "google",
        mode: "connect",
        wasConfigured: false,
      },
    });
    await announceSettingsWritten(["google"]);
    await vi.waitFor(() =>
      assert.ok(
        warn.mock.calls.some((call) =>
          String(call[0]).includes("could not check connection cards"),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(unhandled.mock.calls.length, 0);
  } finally {
    process.off("unhandledRejection", unhandled);
    rmSync(path);
    if (hadFile) renameSync(saved, path);
  }
});

test("a Slack connection card resolves once both tokens are stored", async () => {
  const { saveSettings } = await import("./settingsService.ts");
  await saveSettings({ slack: { disconnect: true } });
  const card = createApproval({
    sessionId: "s-slack",
    kind: "settingsInput",
    title: "Connect Slack workspace connection",
    body: {
      kind: "settingsInput",
      path: "slack.connection",
      label: "Slack workspace connection",
      section: "slack",
      mode: "connect",
      wasConfigured: false,
    },
  });
  // Half a connection does not satisfy it.
  await saveSettings({ slack: { userToken: "xoxp-fixture" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(approvalForId(card.id)?.status, "pending");
  await saveSettings({ slack: { botToken: "xoxb-fixture" } });
  await vi.waitFor(() =>
    assert.equal(approvalForId(card.id)?.status, "executed"),
  );
});
