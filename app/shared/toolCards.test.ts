/**
 * The one card decision both ends share. What is pinned here is the RULE,
 * because the server keeps a payload whole exactly when this says a card
 * renders it: the web parity that used to be re-implemented on each side.
 */
import { describe, expect, it } from "vitest";
import {
  knowledgeEntryCardOf,
  toolCardOf,
  toolCardReadsInput,
  toolCardReadsOutput,
  type ToolCardCandidate,
} from "./toolCards.ts";

const relativeOnly = (url: string) =>
  url.startsWith("/api/files/") ? url : null;

function card(
  name: string,
  output: unknown,
  args: unknown = {},
  isError = false,
) {
  const c: ToolCardCandidate = {
    name,
    args,
    output: typeof output === "string" ? output : JSON.stringify(output),
    isError,
  };
  return toolCardOf(c, relativeOnly);
}

describe("toolCardOf", () => {
  it("accepts the Google and Jira cards on any parsed JSON with the render marker, in both spellings", () => {
    for (const name of [
      "google_calendar_list_events",
      "mcp__pa__google_gmail_read",
    ]) {
      expect(card(name, [1, 2], { render: true })).toBe("googleWorkspace");
      expect(card(name, '"text"', { render: true })).toBe("googleWorkspace");
      expect(card(name, { ok: true }, { render: false })).toBeNull();
      expect(card(name, "not json", { render: true })).toBeNull();
      expect(card(name, { ok: true }, { render: true }, true)).toBeNull();
    }
    expect(card("jira_search_issues", [], { render: true })).toBe("jira");
    expect(card("jira_lookup", { kind: "users" }, { render: true })).toBe(
      "jira",
    );
    expect(
      card("jira_lookup", { kind: "fields" }, { render: true }),
    ).toBeNull();
    expect(card("jira_lookup", ["users"], { render: true })).toBeNull();
    expect(
      card(
        "jira_mutate_issue",
        { renderKind: "jiraIssueMutation" },
        { render: true },
      ),
    ).toBeNull();
  });

  it("requires a valid card shape and no refused rendering for peer prompts and show_files", () => {
    const peer = (patch: Record<string, unknown>) => ({
      renderKind: "sessionPeerPrompt",
      card: { direction: "sent", message: "m", state: "queued", ...patch },
    });
    expect(card("session_send_prompt", peer({}))).toBe("peerPrompt");
    expect(card("mcp__pa__session_send_prompt", peer({}))).toBe("peerPrompt");
    expect(card("session_send_prompt", peer({ message: 1 }))).toBeNull();
    expect(card("session_send_prompt", peer({ state: "unknown" }))).toBeNull();
    expect(
      card("session_send_prompt", { ...peer({}), renderRequested: false }),
    ).toBeNull();

    const files = (url: string) => ({
      renderKind: "showFiles",
      card: { files: [{ url, name: "a.png" }] },
    });
    expect(card("show_files", files("/api/files/home/a.png"))).toBe(
      "showFiles",
    );
    expect(
      card("show_files", files("https://foreign.example/a.png")),
    ).toBeNull();
    expect(
      card("show_files", {
        ...files("/api/files/home/a.png"),
        renderRequested: false,
      }),
    ).toBeNull();
  });

  it("cards a kb_show result only when it names a file", () => {
    const shown = (patch: Record<string, unknown>) => ({
      renderKind: "knowledgeEntry",
      version: 2,
      card: { title: "Alpha", path: "notes/alpha.md", ...patch },
    });
    expect(card("kb_show", shown({}))).toBe("knowledgeEntry");
    expect(card("mcp__pa__kb_show", shown({}))).toBe("knowledgeEntry");
    expect(card("kb_show", shown({ path: "" }))).toBeNull();
    expect(card("kb_show", shown({ title: 3 }))).toBeNull();
    expect(card("kb_show", { renderKind: "knowledgeEntry" })).toBeNull();
    expect(card("kb_read", shown({}))).toBeNull();
    expect(card("kb_show", shown({}), {}, true)).toBeNull();
    // A shape this parser was not written against is refused.
    expect(card("kb_show", { ...shown({}), version: 3 })).toBeNull();
    expect(card("kb_show", { ...shown({}), version: undefined })).toBeNull();
  });

  it("opens an older kb_show_entry card on its folder's index.md", () => {
    expect(
      knowledgeEntryCardOf({
        name: "kb_show_entry",
        args: {},
        isError: false,
        output: JSON.stringify({
          renderKind: "knowledgeEntry",
          version: 1,
          card: { entryId: "kb-a", title: "Alpha", path: "notes/alpha" },
        }),
      }),
    ).toEqual({ path: "notes/alpha/index.md", title: "Alpha" });
  });

  it("bounds the prose a kb_show payload puts in the transcript", () => {
    const long = "x".repeat(5000);
    const parsed = knowledgeEntryCardOf({
      name: "kb_show",
      args: {},
      isError: false,
      output: JSON.stringify({
        renderKind: "knowledgeEntry",
        version: 2,
        card: { title: long, path: long, summary: long, note: long },
      }),
    });
    // What a payload CAN do is fill the transcript, and every field is clipped.
    for (const text of [
      parsed?.title,
      parsed?.path,
      parsed?.summary,
      parsed?.note,
    ])
      expect(text?.length).toBe(400);
  });

  it("renders a task_manage card only for a payload with something that happened", () => {
    const base = { renderKind: "taskManage" };
    expect(
      card("task_manage", { ...base, changed: [], deletedIds: [] }),
    ).toBeNull();
    expect(card("task_manage", { ...base, changed: [{ id: "1" }] })).toBeNull();
    expect(
      card("task_manage", { ...base, changed: [{ id: "1", status: "todo" }] }),
    ).toBe("taskManage");
    expect(card("mcp__pa__task_manage", { ...base, deletedIds: ["1"] })).toBe(
      "taskManage",
    );
    expect(card("task_manage", { ...base, comments: [{ taskId: "1" }] })).toBe(
      "taskManage",
    );
    expect(card("task_read", { ...base, deletedIds: ["1"] })).toBeNull();
  });

  it("knows which cards read the call and which the result", () => {
    expect(card("ask_questions", "anything", { questions: [] })).toBe(
      "agentQuestion",
    );
    expect(card("ask_questions", "anything", {}, true)).toBeNull();
    expect(toolCardReadsInput("agentQuestion")).toBe(true);
    expect(toolCardReadsOutput("agentQuestion")).toBe(false);
    expect(toolCardReadsInput("taskManage")).toBe(true);
    for (const kind of [
      "googleWorkspace",
      "jira",
      "workshopDraftHandoff",
      "peerPrompt",
      "worktreeCommit",
      "worktreePush",
      "showFiles",
      "knowledgeEntry",
    ] as const) {
      expect(toolCardReadsInput(kind), kind).toBe(false);
      expect(toolCardReadsOutput(kind), kind).toBe(true);
    }
  });
});
