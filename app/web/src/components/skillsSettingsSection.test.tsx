// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  AppSettings,
  SkillLibraryList,
  SkillToggles,
} from "@assistant/shared";
import {
  failed,
  idle,
  loading,
  ready,
  refreshing,
  type LoadState,
} from "../lib/loadState.ts";
import { SkillsSettingsSection } from "./SkillsSettingsSection.tsx";

/**
 * How the library draws the five states (`app/web/docs/loading-states.md`).
 * Two of them carry the rules that make this surface trustworthy: "no skills
 * yet" may only appear once a scan has ANSWERED (R1), and a failed rescan keeps
 * the rows it already had (R2) — otherwise a transient read error looks exactly
 * like a deleted library.
 *
 * The toggles ([Task-613](pa://task/613)) are held to the same standard: a
 * checkbox reports the settings it was given and nothing else, so a click that
 * was never persisted cannot leave a skill looking enabled.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LIST: SkillLibraryList = {
  libraryPath: "/data/skills",
  skills: [
    {
      name: "release-notes",
      description: "Draft release notes from merged pull requests.",
      path: "release-notes/SKILL.md",
    },
  ],
  diagnostics: [
    {
      code: "missing-name",
      folder: "half-written",
      path: "half-written/SKILL.md",
      error: "Missing frontmatter name.",
    },
  ],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let asked: [name: string, on: boolean][] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  asked = [];
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function show(
  library: LoadState<SkillLibraryList>,
  skills: SkillToggles = {},
): void {
  act(() => {
    root!.render(
      <SkillsSettingsSection
        library={library}
        settings={{ skills } as AppSettings}
        onToggleSkill={(name, on) => asked.push([name, on])}
      />,
    );
  });
}

function text(): string {
  return container!.textContent ?? "";
}

function toggles(): HTMLInputElement[] {
  return [
    ...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ];
}

it("waits for the scan before claiming the library is empty", () => {
  show(idle());
  expect(text()).not.toContain("No skills yet");

  show(loading());
  expect(text()).toContain("Scanning the skills library…");
  expect(text()).not.toContain("No skills yet");

  show(ready({ libraryPath: "/data/skills", skills: [], diagnostics: [] }));
  expect(text()).toContain("No skills yet");
});

it("lists every skill and every scan diagnostic", () => {
  show(ready(LIST));

  expect(text()).toContain("release-notes");
  expect(text()).toContain("Draft release notes from merged pull requests.");
  expect(text()).toContain("release-notes/SKILL.md");
  // The malformed folder stays visible WITH its reason rather than vanishing.
  expect(text()).toContain("half-written");
  expect(text()).toContain("Missing frontmatter name.");
  expect(text()).toContain("/data/skills");
});

it("says the library is unusable when only broken folders were found", () => {
  show(
    ready({
      libraryPath: "/data/skills",
      skills: [],
      diagnostics: LIST.diagnostics,
    }),
  );

  expect(text()).toContain("No usable skills");
  expect(text()).not.toContain("No skills yet");
  expect(text()).toContain("Missing frontmatter name.");
});

it("keeps the rows on screen while a rescan runs and when it fails", () => {
  show(refreshing(LIST));
  expect(text()).toContain("release-notes");
  expect(text()).toContain("Rescanning skills");

  show(failed("Failed to read the skills library: EACCES", LIST));
  expect(text()).toContain("Failed to read the skills library: EACCES");
  expect(text()).toContain("release-notes");
  expect(text()).not.toContain("No skills yet");
});

it("shows a skill as off until the settings say otherwise", () => {
  show(ready(LIST));
  expect(toggles()).toHaveLength(1);
  expect(toggles()[0]?.checked).toBe(false);

  show(ready(LIST), { "release-notes": "on" });
  expect(toggles()[0]?.checked).toBe(true);

  // A deliberate "off" reads exactly like an absent entry.
  show(ready(LIST), { "release-notes": "off" });
  expect(toggles()[0]?.checked).toBe(false);
});

it("gives a broken folder no way to be turned on", () => {
  show(
    ready({
      libraryPath: "/data/skills",
      skills: [],
      diagnostics: LIST.diagnostics,
    }),
  );

  // The diagnostic row has no valid declared name, so there is nothing to
  // enable — and no control that would suggest otherwise.
  expect(text()).toContain("half-written");
  expect(toggles()).toHaveLength(0);
});

it("asks for ONE name rather than composing the replacement map", () => {
  // The whole-section replacement is built in `useAssistant`, which is the only
  // layer that knows what a still-pending write already sent.
  show(ready(LIST), { triage: "on", "release-notes": "off" });

  act(() => toggles()[0]?.click());
  expect(asked).toEqual([["release-notes", true]]);

  asked = [];
  show(ready(LIST), { triage: "on", "release-notes": "on" });
  act(() => toggles()[0]?.click());
  expect(asked).toEqual([["release-notes", false]]);
});

it("keeps no state of its own, so an unpersisted click claims nothing", () => {
  show(ready(LIST));

  act(() => toggles()[0]?.click());
  expect(asked).toHaveLength(1);

  // The save has not come back (here it never will). Re-rendering with the
  // settings unchanged must leave the skill off: only the echo may say on.
  show(ready(LIST));
  expect(toggles()[0]?.checked).toBe(false);
});

it("reports a first scan that failed without inventing an empty library", () => {
  show(failed("Failed to read the skills library: EACCES"));

  expect(text()).toContain("Failed to read the skills library: EACCES");
  expect(text()).not.toContain("No skills yet");
  expect(text()).not.toContain("Available skills");
});
