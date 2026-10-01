// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AppSettings,
  SkillDetail,
  SkillDetailResponse,
  SkillFilePreviewResponse,
  SkillLibraryList,
} from "@assistant/shared";
import { ready, type LoadState } from "../lib/loadState.ts";
import { SkillsSettingsSection } from "./SkillsSettingsSection.tsx";

/**
 * Opening one skill's `SKILL.md` ([Task-614](pa://task/614)).
 *
 * The rule this file exists for is R3, and it is the whole reason the body is
 * keyed by name: skill A's instructions may never appear under skill B's
 * heading, not while B is loading and not when A's slow answer finally lands.
 * The rest is the ordinary five states plus the two answers only a
 * hand-authored library produces — a folder that went invalid between the scan
 * and the read, and a file too large to serve whole.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Pending {
  name: string;
  resolve: (value: SkillDetailResponse) => void;
  reject: (error: unknown) => void;
}

/** Every detail request, answered by the test. */
const requests: Pending[] = [];
const fileRequests: Array<{
  key: string;
  resolve: (value: SkillFilePreviewResponse) => void;
  reject: (error: unknown) => void;
}> = [];

vi.mock("../lib/skillsApi.ts", () => ({
  fetchSkillDetail: (name: string) =>
    new Promise<SkillDetailResponse>((resolve, reject) => {
      requests.push({ name, resolve, reject });
    }),
  fetchSkillFilePreview: (key: string) =>
    new Promise<SkillFilePreviewResponse>((resolve, reject) => {
      fileRequests.push({ key, resolve, reject });
    }),
  skillFileUrl: (name: string, path: string) => `skill:${name}/${path}`,
}));

const LIST: SkillLibraryList = {
  libraryPath: "/data/skills",
  skills: [
    {
      name: "release-notes",
      description: "Draft release notes.",
      path: "notes-folder/SKILL.md",
    },
    {
      name: "triage",
      description: "Triage inbound issues.",
      path: "triage/SKILL.md",
    },
  ],
  diagnostics: [],
};

function detail(
  name: string,
  markdown: string,
  supporting: SkillDetail["files"]["entries"] = [],
): SkillDetail {
  return {
    kind: "skill",
    name,
    description: `${name} description`,
    folder: name,
    path: `${name}/SKILL.md`,
    markdown,
    bytes: markdown.length,
    truncated: false,
    files: {
      entries: [
        {
          type: "file",
          name: "SKILL.md",
          path: "SKILL.md",
          bytes: markdown.length,
          mimeType: "text/markdown; charset=utf-8",
        },
        ...supporting,
      ],
      entryCount: 1 + supporting.length,
      metadataBytes: 16,
      truncated: false,
      limits: [],
      diagnostics: [],
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  requests.length = 0;
  fileRequests.length = 0;
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

function show(library: LoadState<SkillLibraryList> = ready(LIST)): void {
  act(() => {
    root!.render(
      <SkillsSettingsSection
        library={library}
        settings={{ skills: {} } as AppSettings}
        onToggleSkill={() => {}}
      />,
    );
  });
}

function text(): string {
  return container!.textContent ?? "";
}

function click(label: string): void {
  const button = [...container!.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.includes(label) ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No button for ${label}`);
  act(() => button.click());
}

function clickFile(label: string): void {
  const row = [...container!.querySelectorAll('[role="treeitem"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (!row) throw new Error(`No file row for ${label}`);
  act(() => (row as HTMLElement).click());
}

async function answer(name: string, value: SkillDetailResponse): Promise<void> {
  const pending = requests.filter((request) => request.name === name).at(-1);
  if (!pending) throw new Error(`No request for ${name}`);
  await act(async () => {
    pending.resolve(value);
  });
}

async function answerFile(
  path: string,
  value: SkillFilePreviewResponse,
): Promise<void> {
  const pending = fileRequests
    .filter((request) => request.key.endsWith(`\0${path}`))
    .at(-1);
  if (!pending) throw new Error(`No file request for ${path}`);
  await act(async () => pending.resolve(value));
}

it("reads the opened skill and renders its SKILL.md", async () => {
  show();
  expect(requests).toHaveLength(0);

  click("release-notes");
  expect(requests.map((request) => request.name)).toEqual(["release-notes"]);
  expect(text()).toContain("Reading release-notes/SKILL.md…");

  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep one."),
  );

  expect(text()).toContain("Step one.");
  expect(container!.querySelector("h1")?.textContent).toBe("Notes");
  expect(text()).toContain("release-notes/SKILL.md");
});

it("never shows the previous skill's body under the new name", async () => {
  show();
  click("release-notes");
  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep one."),
  );
  expect(text()).toContain("Step one.");

  click("triage");

  // R3: the placeholder for the new skill, not the old one's instructions.
  expect(text()).not.toContain("Step one.");
  expect(text()).toContain("Reading triage/SKILL.md…");

  await answer("triage", detail("triage", "# Triage\n\nSort it."));
  expect(text()).toContain("Sort it.");
  expect(text()).not.toContain("Step one.");
});

it("drops a late answer for a skill that is no longer open", async () => {
  show();
  click("release-notes");
  const slow = requests[0]!;
  click("triage");

  await act(async () => {
    slow.resolve(detail("release-notes", "# Notes\n\nStep one."));
  });

  expect(text()).not.toContain("Step one.");
  expect(text()).toContain("Reading triage/SKILL.md…");
});

it("keeps the body on screen while a reread runs, and when it fails", async () => {
  show();
  click("release-notes");
  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep one."),
  );

  click("Reread release-notes");
  expect(text()).toContain("Step one.");
  expect(text()).toContain("Rereading SKILL.md");

  await act(async () => {
    requests.at(-1)!.reject(new Error("Failed to read the skill."));
  });

  expect(text()).toContain("Failed to read the skill.");
  expect(text()).toContain("Step one.");
});

it("rereads the open skill when a rescan answers", async () => {
  show();
  click("release-notes");
  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep one."),
  );
  expect(requests).toHaveLength(1);

  // A fresh scan is authoritative over the body too: the same skill is reread
  // in place, and what is on screen stays there while it runs.
  show(ready({ ...LIST }));

  expect(requests.map((request) => request.name)).toEqual([
    "release-notes",
    "release-notes",
  ]);
  expect(text()).toContain("Step one.");

  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep two now."),
  );
  expect(text()).toContain("Step two now.");
});

it("shows a first-read failure with nothing under the name", async () => {
  show();
  click("triage");

  await act(async () => {
    requests.at(-1)!.reject(new Error("Request failed (500)"));
  });

  expect(text()).toContain("Request failed (500)");
  expect(text()).not.toContain("Reading triage/SKILL.md…");
});

it("shows why a skill went unreadable between the scan and the read", async () => {
  show();
  click("triage");

  await answer("triage", {
    kind: "invalid",
    name: "triage",
    folder: "triage",
    path: "triage/SKILL.md",
    error:
      "triage/SKILL.md no longer exists; the library changed since it was scanned.",
  });

  expect(text()).toContain("no longer exists");
  expect(text()).not.toContain("Sort it.");
});

it("says when a served body was cut at the byte bound", async () => {
  show();
  click("triage");

  await answer("triage", {
    ...detail("triage", "# Triage\n\nSort it."),
    bytes: 3 * 1024 * 1024,
    truncated: true,
  });

  expect(text()).toContain("Showing the first 256 KB");
  expect(text()).toContain("3.0 MB");
  expect(text()).toContain("Sort it.");
});

it("browses nested Markdown and code with per-file load states", async () => {
  show();
  click("release-notes");
  await answer(
    "release-notes",
    detail("release-notes", "# Notes", [
      {
        type: "directory",
        name: "references",
        path: "references",
        children: [
          {
            type: "file",
            name: "guide.md",
            path: "references/guide.md",
            bytes: 20,
            mimeType: "text/markdown; charset=utf-8",
          },
          {
            type: "file",
            name: "script.sh",
            path: "references/script.sh",
            bytes: 8,
            mimeType: "text/plain; charset=utf-8",
          },
        ],
      },
    ]),
  );

  expect(text()).toContain("references");
  expect(text()).toContain("guide.md");
  clickFile("guide.md");
  expect(text()).toContain("Loading references/guide.md…");
  expect(fileRequests.map((request) => request.key)).toEqual([
    "release-notes\0references/guide.md",
  ]);
  await answerFile("references/guide.md", {
    kind: "text",
    path: "references/guide.md",
    mimeType: "text/markdown; charset=utf-8",
    text: "# Guide\n\nRead this.",
    bytes: 20,
    truncated: false,
  });
  expect(container!.querySelector("h1")?.textContent).toBe("Guide");
  expect(text()).toContain("Read this.");

  clickFile("script.sh");
  expect(text()).not.toContain("Read this.");
  expect(text()).toContain("Loading references/script.sh…");
  expect(fileRequests.map((request) => request.key)).toEqual([
    "release-notes\0references/guide.md",
    "release-notes\0references/script.sh",
  ]);
  await answerFile("references/script.sh", {
    kind: "text",
    path: "references/script.sh",
    mimeType: "text/plain; charset=utf-8",
    text: "echo ok\n",
    bytes: 8,
    truncated: false,
  });
  expect(text()).toContain("echo ok");
});

it("rereads an open supporting file when a rescan rebuilds the same path", async () => {
  const guide = {
    type: "file" as const,
    name: "guide.txt",
    path: "guide.txt",
    bytes: 8,
    mimeType: "text/plain; charset=utf-8",
  };
  show();
  click("triage");
  await answer("triage", detail("triage", "# Triage", [guide]));
  clickFile("guide.txt");
  await answerFile("guide.txt", {
    kind: "text",
    path: "guide.txt",
    mimeType: "text/plain; charset=utf-8",
    text: "old copy",
    bytes: 8,
    truncated: false,
  });
  expect(text()).toContain("old copy");
  expect(fileRequests).toHaveLength(1);

  // The list rescan causes a second detail read. Once that answer rebuilds the
  // same selected tree entry, the open preview reloads in place rather than
  // leaving bytes that may no longer match what an agent would receive.
  show(ready({ ...LIST }));
  await answer("triage", detail("triage", "# Triage", [{ ...guide }]));

  expect(fileRequests.map((request) => request.key)).toEqual([
    "triage\0guide.txt",
    "triage\0guide.txt",
  ]);
  expect(text()).toContain("old copy");
  await answerFile("guide.txt", {
    kind: "text",
    path: "guide.txt",
    mimeType: "text/plain; charset=utf-8",
    text: "new copy",
    bytes: 8,
    truncated: false,
  });
  expect(text()).toContain("new copy");
  expect(text()).not.toContain("old copy");
});

it("shows an empty viewer when a rescan drops the selected supporting path", async () => {
  const guide = {
    type: "file" as const,
    name: "guide.txt",
    path: "guide.txt",
    bytes: 8,
    mimeType: "text/plain; charset=utf-8",
  };
  show();
  click("triage");
  await answer("triage", detail("triage", "# Triage", [guide]));
  clickFile("guide.txt");
  await answerFile("guide.txt", {
    kind: "text",
    path: "guide.txt",
    mimeType: "text/plain; charset=utf-8",
    text: "about to disappear",
    bytes: 8,
    truncated: false,
  });

  show(ready({ ...LIST }));
  await answer("triage", detail("triage", "# Triage"));

  expect(text()).toContain(
    "This file is no longer present in the bounded listing.",
  );
  expect(text()).not.toContain("about to disappear");
  expect(fileRequests).toHaveLength(1);
});

it("shows a file-viewer failure and retries without borrowing another file", async () => {
  show();
  click("triage");
  await answer(
    "triage",
    detail("triage", "# Secret instructions", [
      {
        type: "file",
        name: "guide.txt",
        path: "guide.txt",
        bytes: 8,
        mimeType: "text/plain; charset=utf-8",
      },
    ]),
  );
  clickFile("guide.txt");
  await act(async () =>
    fileRequests.at(-1)!.reject(new Error("File vanished.")),
  );

  expect(text()).toContain("File vanished.");
  expect(text()).not.toContain("Secret instructions");
  click("Retry");
  expect(fileRequests).toHaveLength(2);
  await answerFile("guide.txt", {
    kind: "text",
    path: "guide.txt",
    mimeType: "text/plain; charset=utf-8",
    text: "restored",
    bytes: 8,
    truncated: false,
  });
  expect(text()).toContain("restored");
});

it("previews images and gives unsupported or detected-binary files a safe fallback", async () => {
  show();
  click("triage");
  await answer(
    "triage",
    detail("triage", "# Triage", [
      {
        type: "file",
        name: "diagram.png",
        path: "diagram.png",
        bytes: 100,
        mimeType: "image/png",
      },
      {
        type: "file",
        name: "archive.zip",
        path: "archive.zip",
        bytes: 100,
        mimeType: "application/octet-stream",
      },
      {
        type: "file",
        name: "pretend.txt",
        path: "pretend.txt",
        bytes: 3,
        mimeType: "text/plain; charset=utf-8",
      },
    ]),
  );

  clickFile("diagram.png");
  expect(
    container!.querySelector('img[alt="diagram.png"]')?.getAttribute("src"),
  ).toBe("skill:triage/diagram.png");
  expect(fileRequests).toHaveLength(0);

  clickFile("archive.zip");
  expect(text()).toContain("cannot be previewed safely");
  expect(container!.querySelector('a[download="archive.zip"]')).not.toBeNull();

  clickFile("pretend.txt");
  await answerFile("pretend.txt", {
    kind: "binary",
    path: "pretend.txt",
    mimeType: "text/plain; charset=utf-8",
    bytes: 3,
    truncated: false,
  });
  expect(text()).toContain("cannot be previewed safely");
});

it("surfaces file-tree and file-preview truncation diagnostics", async () => {
  show();
  click("triage");
  const value = detail("triage", "# Triage", [
    {
      type: "file",
      name: "large.txt",
      path: "large.txt",
      bytes: 500_000,
      mimeType: "text/plain; charset=utf-8",
    },
  ]);
  value.files.truncated = true;
  value.files.limits = ["entries", "depth", "metadata-bytes"];
  await answer("triage", value);

  expect(text()).toContain("1,000 entries");
  expect(text()).toContain("16 levels");
  expect(text()).toContain("256 KB of path metadata");

  clickFile("large.txt");
  await answerFile("large.txt", {
    kind: "text",
    path: "large.txt",
    mimeType: "text/plain; charset=utf-8",
    text: "partial",
    bytes: 500_000,
    truncated: true,
  });
  expect(text()).toContain("Showing the first 256 KB");
  expect(text()).toContain("488 KB");
});

it("closes the pane and stops asking", async () => {
  show();
  click("release-notes");
  await answer(
    "release-notes",
    detail("release-notes", "# Notes\n\nStep one."),
  );

  click("Close release-notes");

  expect(text()).not.toContain("Step one.");
  expect(requests).toHaveLength(1);
});
