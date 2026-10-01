import { defineAgentTool } from "../../mcp/tool.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../../config.ts";

const WORKSHOP_DRAFT_RENDER_KIND = "workshopDraftHandoff";

const handoffSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "proposalMarkdown"],
  properties: {
    title: { type: "string", description: "Short proposal title." },
    category: {
      type: "string",
      description:
        "Proposal category folder, e.g. tools, ui, workflow, knowledge. Defaults to tools.",
    },
    proposalMarkdown: {
      type: "string",
      description:
        "Full Markdown proposal to write to assistant-data/proposals/<category>. Make it useful on its own: problem, proposed implementation, files/areas involved, safety/UX constraints, open questions.",
    },
    draftPrompt: {
      type: "string",
      description:
        "Optional composer draft for the Workshop session. Defaults to a prompt that asks Workshop to read the proposal file.",
    },
  },
} as const;

interface WorkshopDraftHandoffPayload {
  renderKind: typeof WORKSHOP_DRAFT_RENDER_KIND;
  version: 1;
  title: string;
  category: string;
  proposalPath: string;
  draftPrompt: string;
  createdAt: string;
  presentationGuidance: string;
}

/**
 * @payload WorkshopDraftHandoffPayload
 * @purpose Structured handoff from Assistant to Workshop: a saved proposal plus a button that creates a Workshop session with an editable draft prompt.
 * @renderWhen The assistant wants to propose code/tool/UI changes without starting implementation automatically.
 * @bounds Writes one Markdown proposal under DATA_DIR/proposals and does not submit the Workshop prompt.
 * @client Render as a compact card with an "Open Workshop draft" action that creates a Workshop session and pre-fills the composer.
 */
const workshopDraftHandoffTool = defineAgentTool<{
  title: string;
  category?: string;
  proposalMarkdown: string;
  draftPrompt?: string;
}>({
  name: "workshop_draft_handoff",
  label: "Workshop: Draft Handoff",
  description:
    "Propose code, tool, UI, or workflow implementation work that belongs in the Workshop agent rather than this restricted one: saves a proposal Markdown file and returns a UI handoff that can create a Workshop session with an editable, unsubmitted draft prompt. It does NOT start implementation — the user opens the handoff, adjusts model/thinking and the prompt, and submits it. Not for normal answers or knowledge updates; durable knowledge goes to kb_write_entry.",
  searchHint:
    "propose implementation handoff workshop draft build change the app feature request",
  parameters: handoffSchema,
  async execute(params) {
    const title = params.title?.trim();
    const proposalMarkdown = params.proposalMarkdown?.trim();
    if (!title) throw new Error("title is required.");
    if (!proposalMarkdown) throw new Error("proposalMarkdown is required.");
    const category = slug(params.category || "tools");
    const dir = join(DATA_DIR, "proposals", category);
    mkdirSync(dir, { recursive: true });
    const createdAt = new Date();
    const proposalPath = join(dir, `${dateStamp(createdAt)}-${slug(title)}.md`);
    writeFileSync(proposalPath, `${proposalMarkdown}\n`, "utf8");
    const draftPrompt =
      params.draftPrompt?.trim() ||
      [
        "Please review this proposal and implement it if appropriate:",
        "",
        proposalPath,
        "",
        "Start by reading the proposal. Ask any clarification questions before making code changes if the proposal is ambiguous.",
      ].join("\n");
    const payload: WorkshopDraftHandoffPayload = {
      renderKind: WORKSHOP_DRAFT_RENDER_KIND,
      version: 1,
      title,
      category,
      proposalPath,
      draftPrompt,
      createdAt: createdAt.toISOString(),
      presentationGuidance:
        "The UI will show a handoff card. Tell the user the proposal was saved and they can open an editable Workshop draft; do not claim implementation has started.",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    };
  },
});

export const assistantWorkshopHandoffTools = [workshopDraftHandoffTool];

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "proposal"
  );
}

function dateStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
