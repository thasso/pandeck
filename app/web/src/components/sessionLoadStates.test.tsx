// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DisplayMessage,
  SessionArtifact,
  SessionState,
  EntryLibraryList,
} from "@assistant/shared";
import {
  previewForSessionRoute,
  spendBootRouteIdentity,
  type SessionPreview,
} from "../lib/sessionPreviewStore.ts";
import { appendLiveMessagesAfterPreview } from "../lib/sessionPreview.ts";
import { failed, loading, ready } from "../lib/loadState.ts";
import { chatRouteFailure, chatRoutePending } from "../lib/chatRouteStage.ts";
import {
  PendingSessionPanel,
  SessionRefreshMark,
  UnavailableSessionPanel,
} from "./SessionStage.tsx";
import {
  ActiveSkillsSection,
  SessionContextSections,
} from "./SessionContextSections.tsx";

/**
 * How the chat surface draws the five states
 * (`app/web/docs/loading-states.md`, Task-435).
 *
 * The rule this file exists for is the SWITCH. A cached transcript is a
 * promise that what is on screen is roughly this session — it can only be kept
 * where nothing else could be on screen yet (a reload or deep link landing on
 * the URL). In-app, chat A → chat B has a live app around it, so B's stage is
 * cleared and waits (R3); painting B as it looked hours ago, under a small
 * pill, is the bug this replaces.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const session: SessionState = {
  sessionId: "s-a",
  harness: "pi",
  agentType: "assistant",
  thinkingLevel: "off",
};

const messages: DisplayMessage[] = [
  {
    id: "m1",
    role: "assistant",
    blocks: [{ kind: "text", text: "Cached answer from this morning" }],
  } as DisplayMessage,
];

const preview: SessionPreview = {
  sessionId: "s-a",
  session,
  messages,
  contextInfo: null,
  savedAt: 1,
};

/** The other session's live rows: what the runtime holds after a switch to B. */
const liveMessagesOfB: DisplayMessage[] = [
  {
    id: "m9",
    role: "assistant",
    blocks: [{ kind: "text", text: "Chat B, still running" }],
  } as DisplayMessage,
];

function routeFor(sessionId: string) {
  return { identity: `session:${sessionId}`, sessionId };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function text(): string {
  return container!.textContent ?? "";
}

function statusRegions(): Element[] {
  return [...container!.querySelectorAll('[role="status"]')];
}

it("paints the cached transcript of the session the app booted on", () => {
  expect(previewForSessionRoute(preview, routeFor("s-a"), "session:s-a")).toBe(
    preview,
  );
});

it("clears the stage for every session reached by in-app navigation", () => {
  // Boot on A, open B: B has no cached paint, whether or not one is stored.
  expect(
    previewForSessionRoute(preview, routeFor("s-b"), "session:s-a"),
  ).toBeNull();
  // …and coming BACK to A is a switch too: the app has been live since, so the
  // stored preview is by now the one thing on this machine we know is stale.
  expect(
    previewForSessionRoute(preview, routeFor("s-a"), "session:s-b"),
  ).toBeNull();
  // Booting on the new-chat route earns nothing either.
  expect(previewForSessionRoute(preview, routeFor("s-a"), "new")).toBeNull();
  expect(
    previewForSessionRoute(
      preview,
      { identity: "tasks", sessionId: null },
      "tasks",
    ),
  ).toBeNull();
});

it("spends the boot paint on the first navigation away, including a return to it", () => {
  // Boot on A. A reconnect or a router re-parse of the same URL keeps the paint.
  let boot: string | null = "session:s-a";
  boot = spendBootRouteIdentity(boot, "session:s-a");
  expect(previewForSessionRoute(preview, routeFor("s-a"), boot)).toBe(preview);

  // Open B in-app: the latch is spent, and B waits for its own snapshot.
  boot = spendBootRouteIdentity(boot, "session:s-b");
  expect(boot).toBeNull();
  expect(previewForSessionRoute(preview, routeFor("s-b"), boot)).toBeNull();

  // Back to A: still spent — which is the point. A's preview would be adopted
  // while the runtime still holds B, and the merge below shows what that costs:
  // with A's anchor absent from B's rows it hands back the LIVE list wholesale,
  // so B's conversation would render under A's URL behind A's session shell.
  boot = spendBootRouteIdentity(boot, "session:s-a");
  expect(previewForSessionRoute(preview, routeFor("s-a"), boot)).toBeNull();
  expect(
    appendLiveMessagesAfterPreview(preview.messages, liveMessagesOfB),
  ).toBe(liveMessagesOfB);
});

it("spends the boot paint on a detour through a non-session route too", () => {
  let boot: string | null = "session:s-a";
  boot = spendBootRouteIdentity(boot, "tasks");
  boot = spendBootRouteIdentity(boot, "session:s-a");
  expect(previewForSessionRoute(preview, routeFor("s-a"), boot)).toBeNull();
});

it("waits for the Assistant to arrive rather than showing the session left behind", () => {
  const opening = {
    route: { name: "permanentAssistant" },
    viewedSessionId: "s-a",
    viewedAgentType: "assistant" as const,
    hasOptimisticSession: false,
    transcriptPending: false,
  };
  // Its route names no id, so only the PERSONA answers "has it arrived".
  expect(chatRoutePending(opening)).toBe(true);
  expect(
    chatRoutePending({
      ...opening,
      viewedSessionId: "s-pa",
      viewedAgentType: "personal-assistant",
    }),
  ).toBe(false);
});

it("waits for a session route until that exact session is in view", () => {
  const onB = {
    route: { name: "session", id: "s-b" },
    viewedSessionId: "s-a",
    viewedAgentType: "assistant" as const,
    hasOptimisticSession: false,
    transcriptPending: false,
  };
  expect(chatRoutePending(onB)).toBe(true);
  expect(chatRoutePending({ ...onB, viewedSessionId: "s-b" })).toBe(false);
  // The session is in view but its transcript has not landed yet.
  expect(
    chatRoutePending({
      ...onB,
      viewedSessionId: "s-b",
      transcriptPending: true,
    }),
  ).toBe(true);
  // A client-staged session renders optimistically and never waits.
  expect(chatRoutePending({ ...onB, hasOptimisticSession: true })).toBe(false);
  // Routes with no chat of their own are never pending.
  expect(chatRoutePending({ ...onB, route: { name: "tasks" } })).toBe(false);
});

it("knows when the session a route waits for can never arrive", () => {
  const unopenable = { "s-b": "This session cannot be opened: EACCES" };
  expect(chatRouteFailure({ name: "session", id: "s-b" }, unopenable)).toBe(
    "This session cannot be opened: EACCES",
  );
  // Another session's failure is not this route's.
  expect(chatRouteFailure({ name: "session", id: "s-a" }, unopenable)).toBe(
    null,
  );
  expect(chatRouteFailure({ name: "tasks" }, unopenable)).toBe(null);
  expect(chatRouteFailure({ name: "permanentAssistant" }, unopenable)).toBe(
    null,
  );
});

it("says a session cannot be opened instead of announcing it is opening", async () => {
  await act(async () =>
    root!.render(
      <UnavailableSessionPanel
        title="Chat B"
        message="This session cannot be opened: EACCES"
      />,
    ),
  );

  // An error region, not a loading one: no status, no spinner, no skeletons.
  expect(statusRegions()).toHaveLength(0);
  expect(container!.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(
    container!.querySelectorAll(".motion-safe\\:animate-pulse").length,
  ).toBe(0);
  expect(container!.querySelector(".motion-safe\\:animate-spin")).toBeNull();
  expect(text()).toContain("Can't open Chat B");
  expect(text()).toContain("This session cannot be opened: EACCES");
  expect(text()).not.toContain("Opening");
});

it("stands in for the transcript with one announcing placeholder", async () => {
  await act(async () => root!.render(<PendingSessionPanel title="Chat B" />));

  const regions = statusRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0]!.hasAttribute("aria-busy")).toBe(false);
  expect(text()).toContain("Opening Chat B");
  // R4: the transcript's first lines are reserved, not left blank.
  expect(
    container!.querySelectorAll(".motion-safe\\:animate-pulse").length,
  ).toBeGreaterThan(0);
  expect(
    container!.querySelector(".motion-safe\\:animate-spin"),
  ).not.toBeNull();
  // R3: nothing of the previous conversation may be under the new id.
  expect(text()).not.toContain("Cached answer from this morning");
});

it("marks a cached boot paint as refreshing in one legible region", async () => {
  await act(async () => root!.render(<SessionRefreshMark />));

  const regions = statusRegions();
  expect(regions).toHaveLength(1);
  expect(regions[0]!.hasAttribute("aria-busy")).toBe(false);
  expect(text()).toContain("Updating session…");
  // It is the only thing telling the reader the transcript is not current, so
  // it reads at body size on full contrast rather than as caption-grey chrome.
  expect(regions[0]!.className).toContain("text-sm");
  expect(regions[0]!.className).toMatch(/\btext-(card-)?foreground\b/);
});

const artifact: SessionArtifact = {
  id: "a1",
  sessionId: "s-a",
  kind: "file",
  label: "Run log",
  name: "run.log",
  mimeType: "text/plain",
  size: 2048,
  url: "/api/session-artifacts/s-a/tool-output/run.log",
  createdAt: 1,
};

async function renderArtifact(): Promise<void> {
  // Artifacts open collapsed; these tests are about the row inside it.
  window.localStorage.setItem(
    "inspector-section:session:s-a:artifacts",
    "open",
  );
  await act(async () =>
    root!.render(
      <SessionContextSections sessionId="s-a" artifacts={[artifact]} />,
    ),
  );
}

it("renders the frozen active-skill names without controls", async () => {
  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["commit-helper", "test-runner"]}
      />,
    ),
  );

  expect(text()).toContain("Skills");
  expect(text()).toContain("2 available");
  expect(text()).toContain("commit-helper");
  expect(text()).toContain("test-runner");
  expect(container!.querySelector('input[type="checkbox"]')).toBeNull();
});

it("shows a mounted skill as available, not loaded, until the agent invokes it", async () => {
  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["commit-helper", "test-runner"]}
        skillInvocations={[
          { at: 1_000, name: "test-runner", via: "read" },
          { at: 2_000, name: "test-runner", via: "skill_tool" },
        ]}
      />,
    ),
  );

  expect(text()).toContain("1 loaded · 2 available");
  const rows = [
    ...container!.querySelectorAll('[aria-label="Session skills"] li'),
  ];
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "test-runner: Loaded",
    "commit-helper: Available",
  ]);
  // A loaded skill says how often on its line; how it came in, and the
  // states themselves, are the tooltip and the accessible name.
  expect(rows[0]?.textContent).toMatch(/^test-runner×2 · /);
  expect(rows[0]?.getAttribute("title")).toMatch(
    /^Body loaded into the model context — 2 times, last via Skill tool at /,
  );
  expect(rows[1]?.textContent).toBe("commit-helper");
  expect(rows[1]?.getAttribute("title")).toBe(
    "Mounted: only the name and description are in context",
  );
});

it("orders loaded, then available, then unmounted skills, alphabetically within each", async () => {
  const library: EntryLibraryList = {
    libraryPath: "/data/skills",
    entries: [
      { name: "zebra", description: "", path: "zebra/SKILL.md" },
      {
        name: "commit-helper",
        description: "",
        path: "commit-helper/SKILL.md",
      },
      { name: "alpha", description: "", path: "alpha/SKILL.md" },
      {
        name: "test-runner",
        description: "",
        path: "test-runner/SKILL.md",
      },
    ],
    diagnostics: [],
  };
  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["test-runner", "commit-helper"]}
        skillInvocations={[{ at: 1_000, name: "test-runner", via: "read" }]}
        skillLibrary={ready(library)}
      />,
    ),
  );

  expect(text()).toContain("1 loaded · 2/4 available");
  expect(
    [...container!.querySelectorAll('[aria-label="Session skills"] li')].map(
      (row) => row.getAttribute("aria-label"),
    ),
  ).toEqual([
    "test-runner: Loaded",
    "commit-helper: Available",
    "alpha: Not mounted",
    "zebra: Not mounted",
  ]);
  expect(
    container!.querySelectorAll('[title="Not mounted for this session"]')
      .length,
  ).toBe(2);
});

it("marks user-only skills and names a slash-command load", async () => {
  const library: EntryLibraryList = {
    libraryPath: "/data/skills",
    entries: [
      {
        name: "deploy",
        description: "",
        path: "deploy/SKILL.md",
        disableModelInvocation: true,
      },
      {
        name: "sealed",
        description: "",
        path: "sealed/SKILL.md",
        disableModelInvocation: true,
        userInvocable: false,
      },
    ],
    diagnostics: [],
  };
  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["deploy", "sealed"]}
        skillInvocations={[{ at: 1_000, name: "deploy", via: "command" }]}
        skillLibrary={ready(library)}
      />,
    ),
  );

  const rows = [
    ...container!.querySelectorAll('[aria-label="Session skills"] li'),
  ];
  // The marker adds to the state; it does not replace it.
  expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
    "deploy: Loaded",
    "sealed: Available",
  ]);
  expect(rows[0]?.textContent).toContain("User-invoked");
  expect(rows[0]?.getAttribute("title")).toMatch(
    /^Body loaded into the model context — via slash command at .*\. The agent does not load it by itself; \/deploy does$/,
  );
  expect(rows[1]?.textContent).toContain("Not loadable");
  expect(rows[1]?.getAttribute("title")).toBe(
    "Mounted: only the name and description are in context. Neither the agent nor /sealed can load it",
  );
});

it("does not present an incomplete skill scan as an empty or complete list", async () => {
  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["commit-helper"]}
        skillLibrary={loading()}
      />,
    ),
  );
  expect(text()).toContain("Loading…");
  expect(text()).not.toContain("1 available");

  await act(async () =>
    root!.render(
      <ActiveSkillsSection
        sessionId="s-a"
        activeSkills={["commit-helper"]}
        skillLibrary={failed("scan failed")}
      />,
    ),
  );
  expect(text()).toContain("Unavailable");
  expect(text()).toContain("scan failed");
  expect(text()).not.toContain("None available");
});

it("omits the Skills section when activeSkills is absent", async () => {
  await act(async () =>
    root!.render(<SessionContextSections sessionId="s-a" />),
  );

  expect(text()).not.toContain("Skills");
  expect(container!.querySelector('[aria-label="Active skills"]')).toBeNull();
});

it("renders the explicit empty coding-session skill state", async () => {
  await act(async () =>
    root!.render(<ActiveSkillsSection sessionId="s-a" activeSkills={[]} />),
  );

  const sectionToggle = container!.querySelector("button");
  expect(sectionToggle?.getAttribute("aria-expanded")).toBe("false");
  expect(text()).toContain("None available");

  await act(async () => {
    sectionToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(text()).toContain(
    "No library skills were available when this session started.",
  );
});

it("lists an artifact as a row whose details are the file's facts, fetching nothing", async () => {
  // The body is the document viewer's to load, behind Open; the row itself
  // never fetches it, so it has no loading or failure state of its own.
  const fetchSpy = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchSpy);
  await renderArtifact();

  const row = container!.querySelector('[data-list-row-id="a1"]')!;
  expect(row.textContent).toContain("Run log");
  expect(row.querySelector('button[aria-label="Open Run log"]')).toBeTruthy();
  await act(async () =>
    row
      .querySelector<HTMLButtonElement>('button[title="Show details"]')!
      .click(),
  );
  expect(row.textContent).toContain("Filerun.log");
  expect(row.textContent).toContain("Typetext/plain");
  expect(fetchSpy).not.toHaveBeenCalled();
});
