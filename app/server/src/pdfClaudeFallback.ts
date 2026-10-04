/**
 * Wires the `convert_pdf` scanned-PDF fallback (`documentConversion.ts`) to the
 * in-process Claude Agent SDK one-shot. The bytes are sent as a Claude document
 * block; model, thinking level, timeout, and the master enable switch come from
 * the `pdfConversion` app settings. Credentials are whatever the Claude SDK is
 * already configured with (subscription or API key). Registered once at startup.
 */
import { Buffer } from "node:buffer";
import { CLAUDE_SDK_PROVIDER } from "@assistant/shared";
import { runOneShot } from "./harnesses/oneShot.ts";
import { accountForSlot } from "./settingsModelSlots.ts";
import { PDF_MIME, setPdfClaudeFallback } from "./documentConversion.ts";
import { getSettings } from "./settings.ts";

const SYSTEM_PROMPT = `You transcribe a PDF document into clean, faithful GitHub-flavored Markdown.

- Reproduce the document's text and structure: headings, paragraphs, lists, and tables.
- Use Markdown tables for tabular data and preserve reading order across columns/pages.
- Do not summarize, translate, editorialize, or invent content that is not in the document.
- Omit page furniture (running headers/footers, page numbers) unless it carries meaning.
- Output only the Markdown transcription, with no preamble or commentary.`;

const USER_PROMPT =
  "Transcribe the attached PDF document to Markdown, following the rules exactly.";

/** Register the Claude document-block fallback used for scanned/image PDFs. */
export function registerPdfClaudeFallback(): void {
  setPdfClaudeFallback(async ({ bytes }) => {
    const settings = getSettings().pdfConversion;
    if (!settings.fallbackEnabled) return null;
    const { text } = await runOneShot({
      model: { provider: CLAUDE_SDK_PROVIDER, modelId: settings.modelId },
      thinkingLevel: settings.thinkingLevel,
      credentialProfileId: accountForSlot(settings),
      noModelMessage: "No Claude model is available for the PDF fallback.",
      systemPrompt: SYSTEM_PROMPT,
      prompt: USER_PROMPT,
      documents: [
        {
          mimeType: PDF_MIME,
          dataBase64: Buffer.from(bytes).toString("base64"),
        },
      ],
      timeoutMs: settings.timeoutMs,
      timeoutMessage: "PDF Claude fallback timed out.",
    });
    const markdown = text.trim();
    return markdown ? { markdown } : null;
  });
}
