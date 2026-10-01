// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { KnowledgeOpenTargetsProvider } from "./KnowledgeOpenTargets.tsx";
import { renderToolBlock } from "./tools/registry.tsx";

/**
 * `kb_show_entry` exists to hand the reader an entry: the card has to show with
 * tools hidden, offer both reading surfaces, and open the entry the SERVER
 * named rather than anything the transcript claims around it.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function showEntryBlock(card: unknown, name = "kb_show_entry"): DisplayBlock {
  return {
    kind: "tool",
    toolId: "tc1",
    name,
    args: { entryId: "kb-alpha" },
    output: JSON.stringify({ renderKind: "knowledgeEntry", version: 1, card }),
    isError: false,
    done: true,
  };
}

function renderNode(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

function renderCard(
  block: DisplayBlock,
  targets: {
    openInMain: (entryId: string) => void;
    openInPanel?: (entryId: string) => void;
  } | null = { openInMain: () => {} },
): void {
  const card = (
    <>
      {renderToolBlock(block as never, {
        showTools: false,
        expandTools: false,
      })}
    </>
  );
  renderNode(
    targets ? (
      <KnowledgeOpenTargetsProvider targets={targets}>
        {card}
      </KnowledgeOpenTargetsProvider>
    ) : (
      card
    ),
  );
}

function click(label: string): void {
  const button = [...container!.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  )!;
  act(() => button.click());
}

const CARD = {
  entryId: "kb-alpha",
  title: "Alpha Entry",
  path: "notes/alpha",
  summary: "Summary of the entry",
  note: "Rewrote the summary",
};

it("opens the carded entry in the side panel or the Knowledge route", () => {
  const panel: string[] = [];
  const main: string[] = [];
  renderCard(showEntryBlock(CARD), {
    openInMain: (entryId) => main.push(entryId),
    openInPanel: (entryId) => panel.push(entryId),
  });

  expect(container!.textContent).toContain("Alpha Entry");
  expect(container!.textContent).toContain("notes/alpha");
  // The agent's own line wins over the frontmatter summary: it says why THIS
  // entry is being shown now.
  expect(container!.textContent).toContain("Rewrote the summary");
  expect(container!.textContent).not.toContain("Summary of the entry");

  click("Open in side panel");
  click("Open in Knowledge");
  expect(panel).toEqual(["kb-alpha"]);
  expect(main).toEqual(["kb-alpha"]);
});

it("offers the route alone where there is no side panel", () => {
  renderCard(showEntryBlock(CARD), { openInMain: () => {} });
  expect(container!.textContent).not.toContain("Open in side panel");
  expect(container!.textContent).toContain("Open in Knowledge");
});

it("leaves a payload that names no entry as an ordinary tool block", () => {
  renderCard(showEntryBlock({ title: "Alpha Entry" }));
  expect(container!.textContent).toBe("");
});
