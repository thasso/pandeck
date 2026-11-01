import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "draft-session-profile-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

const { Connection } = await import("./connection.ts");
const {
  createCredentialProfile,
  setCredentialProfileEnabled,
  patchCredentialProfile,
} = await import("./credentialProfiles.ts");
const { sessionStore } = await import("./db/sessionStore.ts");
const { hub } = await import("./hub.ts");
const { piStore } = await import("./piSdk/piStore.ts");
const { resolveSessionAccount } = await import("./sessionAccount.ts");
const accountRouter = await import("./accountRouter.ts");

interface SentMessage {
  type?: string;
  message?: string;
}

test("message-level draft sessions inherit and persist the source pi profile", async () => {
  const profile = createCredentialProfile({
    name: "Draft source",
    provider: "openai-codex",
  });
  const parentId = "draft-profile-parent";
  const childId = "draft-profile-child";
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
  });

  const originalAcquireNew = piStore.acquireNew;
  const originalListSessions = hub.listSessions;
  let acquiredOptions: unknown;
  const fakeLive = {
    key: childId,
    sessionId: childId,
    nativeFacts: () => ({
      kind: "developer",
      agentType: "developer",
      harness: "pi",
      thinkingLevel: "off",
    }),
    contextInfo: () => ({ sessionId: childId }),
  };
  (
    piStore as unknown as {
      acquireNew: (...args: unknown[]) => Promise<typeof fakeLive>;
    }
  ).acquireNew = async (...args) => {
    acquiredOptions = args[3];
    return fakeLive;
  };
  (hub as unknown as { listSessions: () => Promise<unknown[]> }).listSessions =
    async () => [];

  const sent: SentMessage[] = [];
  const fakeWs = {
    OPEN: 1,
    readyState: 1,
    send: (payload: string) => sent.push(JSON.parse(payload) as SentMessage),
  };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(fakeWs) as unknown as {
    onCreateDraftSession: (
      agentType: string,
      draftText: string,
    ) => Promise<void>;
    viewing: { sessionId: string };
    view: () => void;
  };
  // The draft inherits from the session ON SHOW, whether or not its harness is
  // open: a session viewed from storage has no live pi session to read.
  connection.viewing = { sessionId: parentId };
  connection.view = () => {};

  try {
    await connection.onCreateDraftSession("assistant", "Review this draft");
    assert.deepEqual(acquiredOptions, { credentialProfileId: profile.id });
    assert.equal(sessionStore.get(childId)?.credentialProfileId, profile.id);
    assert.ok(sent.some((message) => message.type === "draftSession"));
    assert.equal(
      sent.some((message) => message.type === "error"),
      false,
    );
  } finally {
    (
      piStore as unknown as {
        acquireNew: typeof originalAcquireNew;
      }
    ).acquireNew = originalAcquireNew;
    (
      hub as unknown as { listSessions: typeof originalListSessions }
    ).listSessions = originalListSessions;
  }
});

test("bound enterprise drafts retain disabled accounts, refuse demotion, and cannot clear the parent requirement", async () => {
  const profile = createCredentialProfile({
    name: "Bound enterprise draft",
    provider: "openai-codex",
  });
  patchCredentialProfile(profile.id, { enterprise: true });
  setCredentialProfileEnabled(profile.id, false);
  const alternative = createCredentialProfile({
    name: "Other enterprise",
    provider: "openai-codex",
  });
  patchCredentialProfile(alternative.id, { enterprise: true });
  const parentId = "enterprise-draft-parent";
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
    requiresEnterprise: true,
  });
  const ws = { OPEN: 1, readyState: 1, send() {} };
  const connection = new (
    Connection as unknown as new (ws: unknown) => Record<string, unknown>
  )(ws) as unknown as {
    viewing: { sessionId: string };
    onNewSession: (agentType: string) => Promise<void>;
  };
  connection.viewing = { sessionId: parentId };
  const acquire = vi
    .spyOn(piStore, "acquireNew")
    .mockImplementation(async () => {
      throw new Error(
        "A refused enterprise draft must not create a native session.",
      );
    });
  try {
    assert.equal(
      await resolveSessionAccount(
        "openai-codex",
        { credentialProfileId: profile.id, requiresEnterprise: true },
        { allowDisabledPin: true },
      ),
      profile.id,
    );
    patchCredentialProfile(profile.id, { enterprise: false });
    await assert.rejects(
      resolveSessionAccount(
        "openai-codex",
        { credentialProfileId: profile.id, requiresEnterprise: true },
        { allowDisabledPin: true },
      ),
      /requires an enterprise account/,
    );
    await assert.rejects(
      connection.onNewSession("assistant"),
      /requires an enterprise account/,
    );
    assert.equal(acquire.mock.calls.length, 0);
    assert.equal(sessionStore.get(parentId)?.requiresEnterprise, true);
    assert.equal(sessionStore.get(parentId)?.credentialProfileId, profile.id);
    sessionStore.markDeleted(parentId);
    await assert.rejects(
      connection.onNewSession("assistant"),
      /requires an enterprise account/,
    );
    assert.equal(
      sessionStore.getIncludingDeleted(parentId)?.requiresEnterprise,
      true,
    );
    assert.equal(acquire.mock.calls.length, 0);
  } finally {
    acquire.mockRestore();
  }
});

for (const path of ["draft", "newSession"] as const) {
  for (const enterprise of [false, true]) {
    test(`${path} from a Claude parent picks an OpenAI account, enterprise=${enterprise}`, async () => {
      const claude = createCredentialProfile({
        name: "Claude source",
        provider: "claude",
      });
      const openai = createCredentialProfile({
        name: "OpenAI target",
        provider: "openai-codex",
      });
      patchCredentialProfile(claude.id, { enterprise });
      patchCredentialProfile(openai.id, { enterprise });
      const parentId = `claude-draft-${path}-${enterprise}`;
      const childId = `pi-draft-${path}-${enterprise}`;
      sessionStore.upsert({
        id: parentId,
        harness: "claude-sdk",
        agentType: "assistant",
        credentialProfileId: claude.id,
        requiresEnterprise: enterprise,
        provider: "claude",
        model: "sonnet",
        thinkingLevel: "low",
      });
      const picker = vi
        .spyOn(accountRouter, "pickAccount")
        .mockResolvedValue({ profileId: openai.id });
      const fakeLive = {
        key: childId,
        sessionId: childId,
        nativeFacts: () => ({
          kind: "developer",
          agentType: "developer",
          harness: "pi",
          thinkingLevel: "off",
        }),
        contextInfo: () => ({}),
      };
      const acquire = vi
        .spyOn(piStore, "acquireNew")
        .mockResolvedValue(fakeLive as never);
      const list = vi.spyOn(hub, "listSessions").mockResolvedValue([]);
      const sent: SentMessage[] = [];
      const ws = {
        OPEN: 1,
        readyState: 1,
        send: (payload: string) =>
          sent.push(JSON.parse(payload) as SentMessage),
      };
      const connection = new (
        Connection as unknown as new (ws: unknown) => unknown
      )(ws) as {
        viewing: { sessionId: string };
        view: () => void;
        onNewSession: (agentType: string) => Promise<void>;
        onCreateDraftSession: (
          agentType: string,
          text: string,
        ) => Promise<void>;
      };
      connection.viewing = { sessionId: parentId };
      connection.view = () => {};
      try {
        if (path === "draft")
          await connection.onCreateDraftSession(
            "assistant",
            "Draft from Claude",
          );
        else await connection.onNewSession("assistant");
        assert.equal(picker.mock.calls.length, 1);
        assert.equal(picker.mock.calls[0]?.[0].model.provider, "openai-codex");
        assert.equal(
          picker.mock.calls[0]?.[0].requiresEnterprise === true,
          enterprise,
        );
        assert.equal(sessionStore.get(childId)?.credentialProfileId, openai.id);
        assert.equal(
          sessionStore.get(childId)?.requiresEnterprise === true,
          enterprise,
        );
        assert.equal(acquire.mock.calls.length, 1);
        assert.equal(
          sent.some((message) => message.type === "error"),
          false,
        );
      } finally {
        picker.mockRestore();
        acquire.mockRestore();
        list.mockRestore();
      }
    });
  }
  test(`${path} from an enterprise Claude parent fails clearly without an enterprise OpenAI account`, async () => {
    const claude = createCredentialProfile({
      name: "Enterprise Claude source",
      provider: "claude",
    });
    patchCredentialProfile(claude.id, { enterprise: true });
    const parentId = `claude-draft-no-account-${path}`;
    sessionStore.upsert({
      id: parentId,
      harness: "claude-sdk",
      agentType: "assistant",
      credentialProfileId: claude.id,
      requiresEnterprise: true,
    });
    const picker = vi.spyOn(accountRouter, "pickAccount").mockResolvedValue({
      profileId: null,
      degraded: "no-enterprise-account",
    });
    const acquire = vi.spyOn(piStore, "acquireNew");
    const sent: SentMessage[] = [];
    const ws = {
      OPEN: 1,
      readyState: 1,
      send: (payload: string) => sent.push(JSON.parse(payload) as SentMessage),
    };
    const connection = new (
      Connection as unknown as new (ws: unknown) => unknown
    )(ws) as {
      viewing: { sessionId: string };
      onNewSession: (agentType: string) => Promise<void>;
      onCreateDraftSession: (agentType: string, text: string) => Promise<void>;
    };
    connection.viewing = { sessionId: parentId };
    try {
      if (path === "draft") {
        await connection.onCreateDraftSession("assistant", "Refused draft");
        assert.ok(
          sent.some((message) =>
            /No enabled enterprise OpenAI account/.test(message.message ?? ""),
          ),
        );
      } else
        await assert.rejects(
          connection.onNewSession("assistant"),
          /No enabled enterprise OpenAI account/,
        );
      assert.equal(acquire.mock.calls.length, 0);
    } finally {
      picker.mockRestore();
      acquire.mockRestore();
    }
  });
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
