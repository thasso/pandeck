import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test, vi } from "vitest";
import { setAgentHandoffDeliveryStoppedForTests } from "../../agentHandoffs.ts";
import {
  claudeConfigDir,
  clearCredentialProfileLoginState,
  setCredentialProfileLoginState,
} from "../../credentialProfiles.ts";
import {
  approvalForId,
  approvalsForSession,
  resolveApproval,
} from "../../pendingApprovals.ts";
import { getSettings } from "../../settings.ts";
import { saveSettings } from "../../settingsService.ts";
import "../../settingsInput.ts";
import { settingsTools } from "./settingsTools.ts";

const tool = (name: string) => settingsTools.find((t) => t.name === name)!;

function ctx(sessionId: string) {
  return { toolCallId: `call-${sessionId}`, session: { sessionId } } as never;
}

async function call(name: string, params: Record<string, unknown>) {
  const result = await tool(name).execute(params, ctx("s-accounts"));
  return result.details as Record<string, unknown>;
}

type Account = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  status: string;
  pinnedBy?: string[];
};

async function create(name: string, provider = "claude"): Promise<Account> {
  const { created } = (await call("accounts_update", {
    operation: "create",
    provider,
    name,
  })) as { created: Account };
  return created;
}

beforeAll(() => setAgentHandoffDeliveryStoppedForTests(true));
afterAll(() => setAgentHandoffDeliveryStoppedForTests(false));

describe("accounts_read and accounts_update", () => {
  test("creates, renames, disables and lists an account without its login details", async () => {
    const account = await create("Work Claude");
    assert.equal(account.status, "disconnected");
    await call("accounts_update", {
      operation: "rename",
      id: account.id,
      name: "Office Claude",
    });
    await call("accounts_update", { operation: "disable", id: account.id });
    // A login in progress carries a device code; it never reaches the agent.
    setCredentialProfileLoginState(account.id, {
      status: "connecting",
      verificationUri: "https://example.invalid/device",
      userCode: "WXYZ-1234",
    });
    const result = await tool("accounts_read").execute({}, ctx("s-accounts"));
    const text = JSON.stringify(result);
    assert.equal(text.includes("WXYZ-1234"), false);
    assert.equal(text.includes("example.invalid/device"), false);
    clearCredentialProfileLoginState(account.id);
    const listed = (result.details as { accounts: Account[] }).accounts.find(
      (a) => a.id === account.id,
    );
    assert.equal(listed?.name, "Office Claude");
    assert.equal(listed?.enabled, false);
  });

  test("deleting an account unpins it from every setting", async () => {
    const account = await create("Spare Claude");
    await saveSettings({
      commitAgent: {
        ...getSettings().commitAgent,
        provider: "claude-sdk",
        modelId: "sonnet",
        credentialProfileId: account.id,
      },
    });
    const { pinnedBy } = (
      (await call("accounts_read", {})) as { accounts: Account[] }
    ).accounts.find((a) => a.id === account.id)!;
    assert.deepEqual(pinnedBy, ["commitAgent"]);
    const deleted = await call("accounts_update", {
      operation: "delete",
      id: account.id,
    });
    assert.deepEqual(deleted, {
      deleted: account.id,
      unpinned: ["commitAgent"],
    });
    assert.equal(getSettings().commitAgent.credentialProfileId, undefined);
  });

  test("refuses what the Settings page refuses", async () => {
    await assert.rejects(
      call("accounts_update", { operation: "delete", id: "claude-default" }),
      /default profile cannot be deleted/,
    );
    await assert.rejects(
      call("accounts_update", { operation: "rename", id: "nope", name: "x" }),
      /No account nope/,
    );
    await assert.rejects(
      call("accounts_update", {
        operation: "create",
        provider: "x",
        name: "y",
      }),
      /provider must be one of claude, openai-codex/,
    );
    await assert.rejects(
      call("accounts_update", { operation: "explode" }),
      /operation must be/,
    );
  });
});

describe("accounts_sign_in", () => {
  test("raises a sign-in card that resolves once the account is signed in", async () => {
    const account = await create("New Claude");
    const result = await tool("accounts_sign_in").execute(
      { id: account.id, reason: "For the reviews." },
      ctx("s-sign-in"),
    );
    assert.equal(result.terminate, true);
    const card = approvalsForSession("s-sign-in").find(
      (c) => c.status === "pending",
    )!;
    assert.deepEqual(card.body, {
      kind: "settingsInput",
      path: `accounts.${account.id}`,
      label: "New Claude",
      section: "claude-sdk",
      mode: "signIn",
      account: { id: account.id, provider: "claude" },
      reason: "For the reviews.",
      wasConfigured: false,
    });
    await assert.rejects(
      resolveApproval(card.id, "approved"),
      /not signed in yet/,
    );
    // The Claude CLI login finishing: credentials on disk, login state cleared.
    writeFileSync(join(claudeConfigDir(account.id), ".credentials.json"), "{}");
    clearCredentialProfileLoginState(account.id);
    // The first approval broadcast loads the hub, slow in a cold process.
    await vi.waitFor(
      () => assert.equal(approvalForId(card.id)?.status, "executed"),
      { timeout: 15_000 },
    );
    assert.equal(
      approvalForId(card.id)?.resultSummary,
      "New Claude: signed in.",
    );
  });

  test("refuses a disabled account", async () => {
    const account = await create("Off Claude");
    await call("accounts_update", { operation: "disable", id: account.id });
    await assert.rejects(
      tool("accounts_sign_in").execute({ id: account.id }, ctx("s-off")),
      /disabled; enable it with accounts_update first/,
    );
  });
});

describe("review fixes", () => {
  test("a login error never reaches the agent, whatever it quotes", async () => {
    const { created } = (await call("accounts_update", {
      operation: "create",
      provider: "openai-codex",
      name: "Errored OpenAI",
    })) as { created: Account };
    const leaked = [
      "WXYZ-9876",
      "https://example.invalid/device?code=fixture",
      "fixture-oauth-value",
      Buffer.from("fixture-oauth-value").toString("base64"),
    ];
    setCredentialProfileLoginState(created.id, {
      status: "error",
      error: `login failed: ${leaked.join(" ")}`,
    });
    try {
      const result = await tool("accounts_read").execute({}, ctx("s-err"));
      const text = JSON.stringify(result);
      for (const value of leaked) assert.equal(text.includes(value), false);
      const entry = (
        result.details as { accounts: Array<Account & { note?: string }> }
      ).accounts.find((a) => a.id === created.id);
      assert.equal(entry?.status, "error");
      assert.match(entry?.note ?? "", /\/settings\/openai/);
    } finally {
      clearCredentialProfileLoginState(created.id);
    }
  });

  test("an account already signed in gets no card", async () => {
    const account = await create("Ready Claude");
    writeFileSync(join(claudeConfigDir(account.id), ".credentials.json"), "{}");
    const result = await tool("accounts_sign_in").execute(
      { id: account.id },
      ctx("s-ready"),
    );
    assert.equal(result.terminate, undefined);
    assert.equal(
      (result.details as { alreadySignedIn?: string }).alreadySignedIn,
      account.id,
    );
    assert.equal(approvalsForSession("s-ready").length, 0);
  });

  test("an OpenAI login that persists without announcing itself still resolves the card", async () => {
    const { mkdirSync } = await import("node:fs");
    const { piAgentDir } = await import("../../credentialProfiles.ts");
    const { setSignInReconcileIntervalForTests } =
      await import("../../settingsInput.ts");
    setSignInReconcileIntervalForTests(50);
    try {
      const { created } = (await call("accounts_update", {
        operation: "create",
        provider: "openai-codex",
        name: "Quiet OpenAI",
      })) as { created: Account };
      await tool("accounts_sign_in").execute(
        { id: created.id },
        ctx("s-quiet"),
      );
      const card = approvalsForSession("s-quiet").find(
        (c) => c.status === "pending",
      )!;
      // The device login starts; its post-login refresh never settles, so the
      // login state is never cleared. Only the credential file changes.
      setCredentialProfileLoginState(created.id, { status: "connecting" });
      mkdirSync(piAgentDir(created.id), { recursive: true });
      writeFileSync(
        join(piAgentDir(created.id), "auth.json"),
        JSON.stringify({ "openai-codex": { type: "oauth" } }),
      );
      await vi.waitFor(
        () => assert.equal(approvalForId(card.id)?.status, "executed"),
        { timeout: 15_000 },
      );
    } finally {
      setSignInReconcileIntervalForTests(3_000);
    }
  });
});
