// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  EntryDetailResponse,
  EntryHistory,
  EntryLibraryList,
} from "@assistant/shared";
import { ready } from "../lib/loadState.ts";
import { AgentsSettingsSection } from "./AgentsSettingsSection.tsx";

/**
 * The Agents page (`docs/agent-definitions.md` "UI"): the shared library page
 * with each definition's runtime, or why it cannot start, and the entry a
 * session inspector linked opened first, history included.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const asked: string[] = [];
/** While set, a history read waits for `release`. */
let holdHistory = false;
let release: () => void = () => {};
const agentsApi = {
  detail: async (name: string): Promise<EntryDetailResponse> => {
    asked.push(`detail:${name}`);
    return {
      kind: "entry",
      name,
      description: "Reviews tests.",
      folder: name,
      path: `${name}/AGENT.md`,
      markdown: "Prove each new test fails without its change.",
      bytes: 48,
      truncated: false,
      files: {
        entries: [
          {
            type: "file",
            name: "AGENT.md",
            path: "AGENT.md",
            bytes: 48,
            mimeType: "text/markdown; charset=utf-8",
          },
        ],
        entryCount: 1,
        metadataBytes: 8,
        truncated: false,
        limits: [],
        diagnostics: [],
      },
    };
  },
  filePreview: () => new Promise(() => {}),
  history: async (name: string): Promise<EntryHistory> => {
    asked.push(`history:${name}`);
    if (holdHistory) await new Promise<void>((resolve) => (release = resolve));
    return {
      commits: [
        {
          shortCommit: "abc1234",
          author: "Developer",
          date: new Date().toISOString(),
          subject: "Raise test-reviewer effort",
        },
      ],
      truncated: false,
    };
  },
  fileUrl: (name: string, path: string) => `agent:${name}/${path}`,
};
vi.mock("../lib/libraryApi.ts", () => ({ libraryApi: () => agentsApi }));

const LIST: EntryLibraryList = {
  libraryPath: "/data/agents",
  entries: [
    {
      name: "test-reviewer",
      description: "Reviews tests.",
      path: "test-reviewer/AGENT.md",
    },
    { name: "stale", description: "Old.", path: "stale/AGENT.md" },
  ],
  diagnostics: [],
  agentRuntimes: {
    "test-reviewer": {
      persona: "developer",
      provider: "claude-sdk",
      modelId: "opus",
      pinnedModel: "claude-opus-5-5",
      thinkingLevel: "high",
    },
    stale: { problem: 'No enabled account offers a model "gemini".' },
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  asked.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

it("shows what each definition runs on, or why it cannot start", () => {
  act(() => root!.render(<AgentsSettingsSection library={ready(LIST)} />));
  const text = container!.textContent ?? "";
  expect(text).toContain(
    "developer · claude-sdk/opus (pinned claude-opus-5-5) · high effort",
  );
  expect(text).toContain(
    'Cannot start: No enabled account offers a model "gemini".',
  );
  expect(asked).toEqual([]);
});

it("opens the linked definition with its AGENT.md and history", async () => {
  await act(async () => {
    root!.render(
      <AgentsSettingsSection
        library={ready(LIST)}
        initialSelected="test-reviewer"
      />,
    );
  });
  const text = container!.textContent ?? "";
  expect(asked).toEqual(["detail:test-reviewer", "history:test-reviewer"]);
  expect(text).toContain("Prove each new test fails without its change.");
  expect(text).toContain("Raise test-reviewer effort");
  expect(text).toContain("abc1234");
});

it("keeps the history on screen while a rescan rereads it", async () => {
  await act(async () => {
    root!.render(
      <AgentsSettingsSection
        library={ready(LIST)}
        initialSelected="test-reviewer"
      />,
    );
  });
  expect(container!.textContent).toContain("Raise test-reviewer effort");

  // A rescan rebuilds the open entry, which rereads its history.
  holdHistory = true;
  await act(async () => {
    root!.render(
      <AgentsSettingsSection
        library={ready({ ...LIST })}
        initialSelected="test-reviewer"
      />,
    );
  });
  const text = container!.textContent ?? "";
  expect(text).toContain("Raise test-reviewer effort");
  // The indicator's label is its screen-reader text.
  expect(text).toContain("Rereading the history of test-reviewer");

  holdHistory = false;
  await act(async () => release());
});
