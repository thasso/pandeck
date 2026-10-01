import { describe, expect, it } from "vitest";
import type { SlashCommandInfo } from "@assistant/shared";
import { resolveSlashSubmit } from "./Composer.tsx";

const commands: SlashCommandInfo[] = [
  {
    name: "commit",
    description: "Commit",
    usage: "/commit",
    agentTypes: ["workshop", "developer"],
  },
  {
    name: "review",
    description: "Open a NEW session staged to code-review this session's work",
    usage: "/review [extra instructions]",
    agentTypes: ["workshop", "developer"],
    execution: "client",
  },
];

const workshopSession = {
  agentType: "workshop",
  harness: "pi",
  streaming: false,
  attachmentCount: 0,
  commentCount: 0,
} as const;

describe("resolveSlashSubmit", () => {
  it("passes non-commands and unregistered slashes through as ordinary sends", () => {
    expect(resolveSlashSubmit("hello", commands, workshopSession)).toEqual({
      kind: "send",
    });
    expect(resolveSlashSubmit("/model gpt", commands, workshopSession)).toEqual(
      { kind: "send" },
    );
  });

  it("dispatches a host command to runSlashCommand with its args", () => {
    expect(
      resolveSlashSubmit("/commit fix the thing", commands, workshopSession),
    ).toEqual({ kind: "host", name: "commit", rawArgs: "fix the thing" });
  });

  it("intercepts a client-execution command and never resolves it to host", () => {
    expect(
      resolveSlashSubmit("/review focus on tests", commands, workshopSession),
    ).toEqual({ kind: "client", name: "review", rawArgs: "focus on tests" });
  });

  it("errors on an inapplicable command instead of sending it to the model", () => {
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        agentType: "assistant",
      }).kind,
    ).toBe("error");
  });

  it("refuses any registered command while streaming or with attachments or comments", () => {
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        streaming: true,
      }).kind,
    ).toBe("error");
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        attachmentCount: 1,
      }).kind,
    ).toBe("error");
    expect(
      resolveSlashSubmit("/review", commands, {
        ...workshopSession,
        commentCount: 1,
      }),
    ).toEqual({
      kind: "error",
      message: "Slash commands do not support attached comments yet.",
    });
  });
});
