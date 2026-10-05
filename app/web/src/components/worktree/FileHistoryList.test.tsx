// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  WorktreeFileLogEntry,
  WorktreeFileLogResponse,
} from "@assistant/shared";
import { mount } from "../../test/mount.tsx";
import { FileHistoryList } from "./FileHistoryList.tsx";

const answers: Array<{
  resolve: (value: WorktreeFileLogResponse) => void;
  reject: (error: Error) => void;
}> = [];

vi.mock("../../lib/worktrees.ts", () => ({
  fetchWorktreeFileLog: () =>
    new Promise<WorktreeFileLogResponse>((resolve, reject) =>
      answers.push({ resolve, reject }),
    ),
}));

function entry(
  subject: string,
  overrides: Partial<WorktreeFileLogEntry> = {},
): WorktreeFileLogEntry {
  return {
    oid: `${subject}-oid`,
    shortOid: subject.slice(0, 7),
    subject,
    author: "Ana",
    authoredAt: Date.now() - 3 * 60_000,
    path: "plan.md",
    parentOid: `${subject}-parent`,
    ...overrides,
  };
}

async function answer(response: Partial<WorktreeFileLogResponse>) {
  await act(async () => {
    answers.shift()!.resolve({
      worktreeId: "wt",
      path: "plan.md",
      entries: [],
      truncated: false,
      ...response,
    });
  });
}

describe("FileHistoryList", () => {
  it("lists the commits and opens the one picked", async () => {
    const onOpenCommit = vi.fn();
    const { container } = mount(
      <FileHistoryList
        worktreeId="wt"
        path="plan.md"
        refreshToken={0}
        onOpenCommit={onOpenCommit}
      />,
    );
    expect(container.textContent).toContain("Loading history");
    await answer({
      entries: [
        entry("rename to plan"),
        entry("extend notes", { path: "notes.md" }),
      ],
      truncated: true,
    });
    expect(container.textContent).toContain("rename to plan");
    expect(container.textContent).toContain("Ana · 3m");
    // A commit from before a rename says which name the file had.
    expect(container.textContent).toContain("as notes.md");
    expect(container.textContent).toContain(
      "Showing the 2 most recent commits.",
    );
    const rows = container.querySelectorAll("button");
    act(() => rows[1]!.click());
    expect(onOpenCommit).toHaveBeenCalledWith(
      expect.objectContaining({ oid: "extend notes-oid", path: "notes.md" }),
    );
  });

  it("says when no commit touches the file", async () => {
    const { container } = mount(
      <FileHistoryList
        worktreeId="wt"
        path="new.md"
        refreshToken={0}
        onOpenCommit={() => {}}
      />,
    );
    await answer({ entries: [] });
    expect(container.textContent).toContain("No commits touch this file yet.");
  });

  it("reports a history that failed to load", async () => {
    const { container } = mount(
      <FileHistoryList
        worktreeId="wt"
        path="plan.md"
        refreshToken={0}
        onOpenCommit={() => {}}
      />,
    );
    await act(async () => {
      answers.shift()!.reject(new Error("git exploded"));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load this file's history: git exploded",
    );
  });
});
