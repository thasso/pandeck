import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { WorkshopDraftHandoffToolCard } from "./WorkshopDraftHandoffCard.tsx";

type ToolBlock = Extract<DisplayBlock, { kind: "tool" }>;

const block: ToolBlock = {
  kind: "tool",
  toolId: "toolu_01Handoff",
  name: "workshop_draft_handoff",
  args: {},
  output: JSON.stringify({
    renderKind: "workshopDraftHandoff",
    version: 1,
    title: "Render `ToolCard` titles **as Markdown**",
    category: "ui",
    proposalPath: "assistant-data/proposals/ui/render_card_titles.md",
    draftPrompt: "Implement the proposal.",
    createdAt: "2026-10-17T00:00:00.000Z",
  }),
  done: true,
  isError: false,
};

describe("WorkshopDraftHandoffToolCard", () => {
  it("renders the proposal title as Markdown and keeps the path verbatim", () => {
    const html = renderToStaticMarkup(
      <WorkshopDraftHandoffToolCard block={block} />,
    );

    expect(html).toContain(
      "Render <code>ToolCard</code> titles <strong>as Markdown</strong>",
    );
    expect(html).toContain("assistant-data/proposals/ui/render_card_titles.md");
    expect(html).not.toContain("<em>");
  });
});
