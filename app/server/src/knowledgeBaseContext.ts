import { Buffer } from "node:buffer";
import type { PromptAttachment } from "@assistant/shared";
import { formatPaObjectLink } from "@assistant/shared/objectLinks";
import { getKnowledgeIndex } from "./knowledgeBaseIndex.ts";
import { KnowledgeBaseStore } from "./knowledgeBaseStore.ts";

function safeAttachmentIdPart(value: string): string {
  // Attachment ids are validated by isSafeId: [A-Za-z0-9_-], max 64.
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 47) || "entry"
  );
}

interface KnowledgeContextRender {
  id: string;
  title: string;
  markdown: string;
}

async function renderKnowledgeContext(
  entryId: string,
  store: KnowledgeBaseStore,
): Promise<KnowledgeContextRender | undefined> {
  const id = entryId.trim();
  if (!id) return undefined;
  const entry = (await getKnowledgeIndex(store)).entries.find(
    (candidate) => candidate.id === id,
  );
  if (!entry) return undefined;
  const uri = formatPaObjectLink({ objectType: "knowledge", id: entry.id });
  const lines = [
    "# Knowledge Base entry context",
    "",
    `- Entry id: ${entry.id}`,
    `- URI: ${uri}`,
    `- Title: ${entry.title}`,
    `- Type: ${entry.type}`,
    `- Status: ${entry.status}`,
    `- Path: ${entry.path}`,
    ...(entry.summary ? [`- Summary: ${entry.summary}`] : []),
    ...(entry.tags.length ? [`- Tags: ${entry.tags.join(", ")}`] : []),
  ];
  lines.push(
    "",
    "This Knowledge entry was attached as structured context. Do not assume the raw body is present; use the `kb_get_entry` tool with the entry id above when you need the current content, assets, or full metadata.",
  );
  return {
    id: entry.id,
    title: entry.title,
    markdown: lines.join("\n"),
  };
}

/**
 * Build a structured KB-entry context attachment for a new session.
 *
 * The attachment deliberately carries only compact metadata and durable refs, not
 * the raw Markdown body. Agents should use `kb_get_entry` for explicit reads.
 */
export async function buildKnowledgeContextAttachment(
  entryId: string,
  store = new KnowledgeBaseStore(),
): Promise<PromptAttachment | undefined> {
  const rendered = await renderKnowledgeContext(entryId, store);
  if (!rendered) return undefined;
  return {
    id: `knowledgectx-${safeAttachmentIdPart(rendered.id)}`,
    name: rendered.title || "Knowledge entry",
    mimeType: "text/markdown",
    size: Buffer.byteLength(rendered.markdown, "utf8"),
    data: Buffer.from(rendered.markdown, "utf8").toString("base64"),
    role: "knowledge-context",
  };
}
