import { describe, expect, it } from "vitest";
import { newSessionShell, stagedTranscript } from "./newSessionShell.ts";

const bootstrapping = {
  isNewChatRoute: true,
  firstSendPending: true,
  autoNamingEnabled: true,
  agentResponding: false,
  worktreeNarrationVisible: false,
  provisionFailed: false,
  error: null,
  sendLanded: false,
};

describe("newSessionShell", () => {
  it("is a session shell only while a first send is out on the staging route", () => {
    expect(newSessionShell(bootstrapping).bootstrapping).toBe(true);
    expect(
      newSessionShell({ ...bootstrapping, firstSendPending: false })
        .bootstrapping,
    ).toBe(false);
    expect(
      newSessionShell({ ...bootstrapping, isNewChatRoute: false })
        .bootstrapping,
    ).toBe(false);
  });

  it("uses one honest placeholder while the naming agent runs", () => {
    expect(newSessionShell(bootstrapping)).toMatchObject({
      title: "Unlabeled Session",
      titleGenerationPending: true,
    });
    expect(
      newSessionShell({
        ...bootstrapping,
        sessionTitle: "Unlabeled Session",
        sessionTitleGenerationPending: false,
      }),
    ).toMatchObject({
      title: "Unlabeled Session",
      titleGenerationPending: false,
    });
    expect(
      newSessionShell({
        ...bootstrapping,
        sessionTitle: "Ship the shell",
        sessionTitleGenerationPending: false,
      }),
    ).toMatchObject({
      title: "Ship the shell",
      titleGenerationPending: false,
    });
  });

  it("keeps the placeholder still when automatic naming is disabled", () => {
    expect(
      newSessionShell({ ...bootstrapping, autoNamingEnabled: false }),
    ).toMatchObject({
      title: "Unlabeled Session",
      titleGenerationPending: false,
    });
  });

  it("carries the staged identity in the subtitle, model first", () => {
    expect(
      newSessionShell({
        ...bootstrapping,
        modelName: "Sonnet",
        worktreeName: "t448-optimistic-shell",
      }).subtitle,
    ).toBe("Sonnet · t448-optimistic-shell");
    // A worktree the send still has to provision has no name to show yet.
    expect(
      newSessionShell({
        ...bootstrapping,
        modelName: "Sonnet",
        newWorktree: true,
        projectName: "Pandeck",
      }).subtitle,
    ).toBe("Sonnet · new worktree");
    expect(
      newSessionShell({
        ...bootstrapping,
        modelName: "Sonnet",
        projectName: "Pandeck",
      }).subtitle,
    ).toBe("Sonnet · Pandeck");
    expect(newSessionShell(bootstrapping).subtitle).toBe("");
  });

  it("narrates the bootstrap until the agent takes over", () => {
    expect(newSessionShell(bootstrapping).narration).toEqual({
      kind: "starting",
      label: "Starting session…",
    });
    expect(
      newSessionShell({ ...bootstrapping, agentResponding: true }).narration,
    ).toBeNull();
    expect(
      newSessionShell({ ...bootstrapping, firstSendPending: false }).narration,
    ).toBeNull();
  });

  it("stands down while the worktree card narrates the same bootstrap", () => {
    // One narration per source: the card carries the phase, the blocker and its
    // own Retry, so this must not say either thing a second time.
    expect(
      newSessionShell({ ...bootstrapping, worktreeNarrationVisible: true })
        .narration,
    ).toBeNull();
    expect(
      newSessionShell({
        ...bootstrapping,
        worktreeNarrationVisible: true,
        error: "Could not create the worktree",
      }).narration,
    ).toBeNull();
  });

  it("reports a failed bootstrap with the server's own blocker", () => {
    expect(
      newSessionShell({
        ...bootstrapping,
        error: "Model openai/gpt-5 is not available.",
      }).narration,
    ).toEqual({
      kind: "failed",
      label: "Could not start the session",
      detail: "Model openai/gpt-5 is not available.",
    });
  });

  it("stops claiming a failed bootstrap once the session exists", () => {
    // The error channel cannot name the send it belongs to, so an unrelated
    // failure lands here too. Once the session is created there is nothing left
    // to fail to start — and a failure claim is also an offer to run the send
    // again, which would make a second session.
    expect(
      newSessionShell({
        ...bootstrapping,
        sendLanded: true,
        error: "Something else failed",
      }).narration,
    ).toEqual({ kind: "starting", label: "Starting session…" });
  });

  it("offers a re-run only for a send that created nothing", () => {
    const failed = { ...bootstrapping, error: "Model x is not available." };
    expect(newSessionShell(failed).retryable).toBe(true);
    // The provisioning card reports its blocker on its own channel and carries
    // the same offer; the rule has to see it.
    expect(
      newSessionShell({
        ...bootstrapping,
        worktreeNarrationVisible: true,
        provisionFailed: true,
      }).retryable,
    ).toBe(true);
    // Landed: re-running would not retry anything, it would create a second
    // session and strand the first.
    expect(newSessionShell({ ...failed, sendLanded: true }).retryable).toBe(
      false,
    );
    // Nothing failed, and nothing is out.
    expect(newSessionShell(bootstrapping).retryable).toBe(false);
    expect(
      newSessionShell({ ...failed, firstSendPending: false }).retryable,
    ).toBe(false);
  });

  // `docs/messaging.md`: an announcement is decided when the message ARRIVES,
  // so this claim has to be true BEFORE the failure lands — while the send is
  // out. A home that only appears once the failure is in state is not a home,
  // and asking afterwards is how a suppression came to defer an arrival instead
  // of consuming it.
  it("claims the next failure while the send is still out", () => {
    expect(newSessionShell(bootstrapping).ownsFailure).toBe(true);
    // Nothing is out: an arriving failure is about something else entirely.
    expect(
      newSessionShell({ ...bootstrapping, firstSendPending: false })
        .ownsFailure,
    ).toBe(false);
    // The provisioning card narrates its own blockers, so this must not claim
    // them as well.
    expect(
      newSessionShell({ ...bootstrapping, worktreeNarrationVisible: true })
        .ownsFailure,
    ).toBe(false);
    // Landed: the session exists, and its own surface owns what happens next.
    expect(
      newSessionShell({ ...bootstrapping, sendLanded: true }).ownsFailure,
    ).toBe(false);
  });
});

describe("stagedTranscript", () => {
  const message = (id: string) => ({ id });
  // Two sessions existed when the send left: the one in view and one more in
  // the list. Whatever this send creates is neither.
  const base = {
    stagedSessionId: "creq-1",
    provisionMessageId: "worktree-provision",
    provisionOwned: false,
    firstSendPending: true,
    viewedSessionId: "s-old",
    knownSessionIdsAtSend: new Set(["s-old", "s-other"]),
  };

  it("shows only this send's rows while the prompt is optimistic", () => {
    expect(
      stagedTranscript({
        ...base,
        optimistic: [{ id: "creq-a", optimisticSessionId: "creq-1" }],
        messages: [message("old-session-row"), message("creq-a")],
      }),
    ).toEqual({ messages: [message("creq-a")], adopted: false, landed: false });
  });

  it("carries the worktree-provisioning row of this send", () => {
    expect(
      stagedTranscript({
        ...base,
        provisionOwned: true,
        optimistic: [{ id: "creq-a", optimisticSessionId: "creq-1" }],
        messages: [message("worktree-provision"), message("creq-a")],
      }).messages,
    ).toEqual([message("worktree-provision"), message("creq-a")]);
  });

  it("adopts the created session's rows when the echo settles", () => {
    // The durable echo reconciles the optimistic row one commit before the URL
    // moves: rendering that commit literally would blank the prompt.
    expect(
      stagedTranscript({
        ...base,
        optimistic: [],
        messages: [message("entry-1")],
        viewedSessionId: "s-new",
      }),
    ).toEqual({
      messages: [message("entry-1")],
      adopted: true,
      landed: true,
    });
  });

  it("adopts nothing that already existed when the send left", () => {
    // The session the send left behind…
    expect(
      stagedTranscript({
        ...base,
        optimistic: [],
        messages: [message("entry-1")],
      }),
    ).toEqual({ messages: [], adopted: false, landed: false });
    // …and any OTHER pre-existing session that drifts into view mid-bootstrap:
    // a late loadSession answer, a background session settling, a
    // server-initiated view switch. `useSessionRouting` refuses to move the URL
    // onto these; painting their rows and identity under the staging URL
    // instead is the same leak with the address bar telling the opposite story.
    expect(
      stagedTranscript({
        ...base,
        optimistic: [],
        messages: [message("other-1"), message("other-2")],
        viewedSessionId: "s-other",
      }),
    ).toEqual({ messages: [], adopted: false, landed: false });
    // Same guarantee for a send that echoes no prompt of its own (a review
    // handoff): with no staged rows to show, this evidence is the ONLY thing
    // keeping another conversation off the staged surface.
    expect(
      stagedTranscript({
        ...base,
        optimistic: [],
        messages: [message("old-1"), message("old-2")],
      }),
    ).toEqual({ messages: [], adopted: false, landed: false });
    // …nor anything at all once no send is out.
    expect(
      stagedTranscript({
        ...base,
        firstSendPending: false,
        optimistic: [],
        messages: [message("entry-1")],
        viewedSessionId: "s-new",
      }),
    ).toEqual({ messages: [], adopted: false, landed: true });
  });

  it("cannot conclude anything before a send has been recorded", () => {
    expect(
      stagedTranscript({
        ...base,
        optimistic: [],
        messages: [message("entry-1")],
        viewedSessionId: "s-new",
        knownSessionIdsAtSend: null,
      }),
    ).toEqual({ messages: [], adopted: false, landed: false });
  });

  it("renders nothing when no session is staged", () => {
    expect(
      stagedTranscript({
        ...base,
        stagedSessionId: null,
        optimistic: [{ id: "creq-a" }],
        messages: [message("creq-a")],
      }),
    ).toEqual({ messages: [], adopted: false, landed: false });
  });
});
