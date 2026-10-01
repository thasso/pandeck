import { describe, expect, it } from "vitest";
import { validateClientMessage } from "./validateClientMessage.ts";

describe("attachComments protocol", () => {
  it("accepts an editable new-session review draft with runtime and attachments", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: {
        kind: "new",
        harness: "pi",
        agentType: "developer",
        modelProvider: "provider",
        modelId: "model",
        thinkingLevel: "medium",
        credentialProfileId: "profile-work",
        additionalPrompt: "Please prioritize the mobile behavior.",
        attachments: [
          {
            id: "a1",
            name: "notes.txt",
            mimeType: "text/plain",
            data: "bm90ZXM=",
            size: 5,
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a bare new-session handoff", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: { kind: "new", harness: "pi" },
    });
    expect(result.ok).toBe(true);
  });

  // The draft is staged on the ordinary new-session surface, where Build/Plan is
  // picked next to the model: the mode has to survive the wire, or the created
  // review session runs a policy the composer said it would not.
  it("carries the staged Build/Plan mode of a new-session draft", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: {
        kind: "new",
        harness: "pi",
        agentType: "developer",
        mode: "plan",
        additionalPrompt: "Review this.",
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-string mode", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: { kind: "new", harness: "pi", mode: 1 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-string credential profile id", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: {
        kind: "new",
        harness: "pi",
        agentType: "developer",
        credentialProfileId: 42,
        additionalPrompt: "Review this.",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts optional additional instructions for an existing session", () => {
    const result = validateClientMessage({
      type: "attachComments",
      threadIds: ["comment-1"],
      session: {
        kind: "existing",
        sessionId: "session-1",
        additionalPrompt: "Only address accessibility.",
      },
    });
    expect(result.ok).toBe(true);
  });
});
