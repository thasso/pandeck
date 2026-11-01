import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "pi-fork-profile-test-"));
process.env.ASSISTANT_CWD = tmp;
process.env.DATA_DIR = join(tmp, "data");

await import("../hub.ts");
const { createCredentialProfile, patchCredentialProfile } =
  await import("../credentialProfiles.ts");
const { sessionStore } = await import("../db/sessionStore.ts");
const { piStore } = await import("./piStore.ts");
const { canonicalPiSessionPath } = await import("../sessionStorage.ts");

const { openPiEngine } = await import("./piEngineHost.ts");

type PiEngineOpened = import("./piEngineHost.ts").PiEngineOpened;
type SessionManager = import("@earendil-works/pi-coding-agent").SessionManager;

interface StoreInternals {
  openEngine: (
    spec: import("./piEngineHost.ts").PiEngineOpenSpec,
  ) => Promise<PiEngineOpened>;
  track: (
    _kind: string,
    opened: PiEngineOpened,
    credentialProfileId: string | undefined,
    _scope?: string,
    requiresEnterprise?: boolean,
  ) => { sessionId: string; sessionFile?: string };
}

/** A stand-in for pi's agent session over the transcript the opener opened. */
function standInSession(sm: SessionManager, dispose = () => {}): never {
  return {
    sessionId: sm.getSessionId(),
    get sessionFile() {
      return sm.getSessionFile();
    },
    sessionManager: sm,
    subscribe: () => () => {},
    dispose,
  } as never;
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeForkableParent(id: string): { file: string; entryId: string } {
  const file = canonicalPiSessionPath(id);
  const entryId = `${id}-entry`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "fork here", timestamp: Date.now() },
      }),
      "",
    ].join("\n"),
  );
  return { file, entryId };
}

test("a pi fork persists its inherited profile and enterprise requirement", async () => {
  const profile = createCredentialProfile({
    name: "Fork account",
    provider: "openai-codex",
  });
  patchCredentialProfile(profile.id, { enterprise: true });
  const parentId = "fork-profile-parent";
  const entryId = "fork-profile-entry";
  const parentFile = canonicalPiSessionPath(parentId);
  mkdirSync(dirname(parentFile), { recursive: true });
  writeFileSync(
    parentFile,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: parentId,
        timestamp: new Date().toISOString(),
        cwd: tmp,
      }),
      JSON.stringify({
        type: "message",
        id: entryId,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "fork here", timestamp: Date.now() },
      }),
      "",
    ].join("\n"),
  );
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
    requiresEnterprise: true,
  });

  const internals = piStore as unknown as StoreInternals;
  const originalOpenEngine = internals.openEngine;
  const originalTrack = internals.track;
  let childFile: string | undefined;
  let reopenedProfileId: string | undefined;
  const trackedProfiles: Array<string | undefined> = [];

  internals.openEngine = async (spec) => {
    reopenedProfileId = spec.credentialProfileId;
    const opened = await openPiEngine(
      spec,
      {} as never,
      async (_spec, _ctx, { sm }) => ({
        session: standInSession(sm),
        notices: [],
      }),
    );
    childFile = opened.info.sessionFile;
    return opened;
  };
  internals.track = (
    _kind,
    { engine },
    credentialProfileId,
    _scope,
    requiresEnterprise,
  ) => {
    if (requiresEnterprise)
      sessionStore.claimScope({
        id: engine.sessionId,
        harness: "pi",
        agentType: "assistant",
        requiresEnterprise: true,
      });
    trackedProfiles.push(credentialProfileId);
    return {
      sessionId: engine.sessionId,
      ...(engine.sessionFile !== undefined
        ? { sessionFile: engine.sessionFile }
        : {}),
    };
  };

  try {
    const forked = await piStore.forkSession(
      "assistant",
      parentFile,
      entryId,
      "at",
      "app-entry-1",
    );
    const childId = forked.sessionId;
    assert.notEqual(childId, parentId);
    assert.equal(sessionStore.get(childId)?.credentialProfileId, profile.id);
    assert.equal(sessionStore.get(childId)?.requiresEnterprise, true);
    assert.deepEqual(trackedProfiles, [profile.id], "the live fork runs on it");

    childFile = canonicalPiSessionPath(childId);
    mkdirSync(dirname(childFile), { recursive: true });
    writeFileSync(
      childFile,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: childId,
          timestamp: new Date().toISOString(),
          cwd: tmp,
          parentSession: parentFile,
        }),
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId: null,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: "fork here",
            timestamp: Date.now(),
          },
        }),
        "",
      ].join("\n"),
    );

    reopenedProfileId = undefined;
    await piStore.acquireExisting("assistant", childFile, childId);
    assert.equal(
      reopenedProfileId,
      profile.id,
      "cold reopen resolves the persisted child binding",
    );
    assert.deepEqual(
      trackedProfiles,
      [profile.id, profile.id],
      "the reopened live session runs on it",
    );

    trackedProfiles.length = 0;
    await piStore.acquireNew("assistant", undefined, undefined, {
      credentialProfileId: profile.id,
    });
    assert.deepEqual(trackedProfiles, [profile.id], "a new session runs on it");
  } finally {
    internals.openEngine = originalOpenEngine;
    internals.track = originalTrack;
  }
});

test.each([false, true])(
  "pi refuses a personal fork account with tombstoned enterprise source=%s",
  async (tombstoned) => {
    const personal = createCredentialProfile({
      name: "Personal fork account",
      provider: "openai-codex",
    });
    const parentId = `pi-personal-enterprise-parent-${tombstoned}`;
    const { file, entryId } = writeForkableParent(parentId);
    const sourceBytes = readFileSync(file);
    sessionStore.upsert({
      id: parentId,
      harness: "pi",
      agentType: "assistant",
      credentialProfileId: personal.id,
      requiresEnterprise: true,
    });
    if (tombstoned) sessionStore.remove(parentId);
    const internals = piStore as unknown as StoreInternals;
    const create = vi.spyOn(internals, "openEngine");

    await assert.rejects(
      piStore.forkSession("assistant", file, entryId, "at", `${parentId}-app`),
      /requires an enterprise account/i,
    );

    assert.equal(create.mock.calls.length, 0);
    assert.deepEqual(readFileSync(file), sourceBytes);
    assert.equal(
      sessionStore.getIncludingDeleted(parentId)?.requiresEnterprise,
      true,
    );
  },
);

test("pi removes a forked child if its enterprise profile is demoted during creation", async () => {
  const profile = createCredentialProfile({
    name: "Enterprise race account",
    provider: "openai-codex",
  });
  patchCredentialProfile(profile.id, { enterprise: true });
  const parentId = "pi-enterprise-race-parent";
  const { file, entryId } = writeForkableParent(parentId);
  const sourceBytes = readFileSync(file);
  sessionStore.upsert({
    id: parentId,
    harness: "pi",
    agentType: "assistant",
    credentialProfileId: profile.id,
    requiresEnterprise: true,
  });

  const internals = piStore as unknown as StoreInternals;
  const originalOpenEngine = internals.openEngine;
  const originalTrack = internals.track;
  const disposed = vi.fn();
  let childId: string | undefined;
  let childFile: string | undefined;
  internals.openEngine = async (spec) => {
    const opened = await openPiEngine(
      spec,
      {} as never,
      async (_spec, _ctx, { sm }) => {
        childId = sm.getSessionId();
        await Promise.resolve();
        patchCredentialProfile(profile.id, { enterprise: false });
        return { session: standInSession(sm, disposed), notices: [] };
      },
    );
    childFile = opened.info.sessionFile;
    return opened;
  };
  const track = vi.spyOn(internals, "track");

  try {
    await assert.rejects(
      piStore.forkSession("assistant", file, entryId, "at", `${parentId}-app`),
      /requires an enterprise account/i,
    );
  } finally {
    patchCredentialProfile(profile.id, { enterprise: true });
    internals.openEngine = originalOpenEngine;
    internals.track = originalTrack;
  }

  assert.ok(childId);
  assert.ok(childFile);
  assert.equal(disposed.mock.calls.length, 1);
  assert.equal(track.mock.calls.length, 0);
  assert.equal(sessionStore.get(childId)?.requiresEnterprise, undefined);
  assert.equal(existsSync(childFile), false);
  assert.deepEqual(readFileSync(file), sourceBytes);
  assert.equal(sessionStore.get(parentId)?.requiresEnterprise, true);
});
