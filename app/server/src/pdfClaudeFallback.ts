/**
 * Wires the `convert_pdf` scanned-PDF fallback (`documentConversion.ts`) to the
 * in-process Claude Agent SDK one-shot. The bytes are sent as a Claude document
 * block; model, thinking level, timeout, and the master enable switch come from
 * the `pdfConversion` app settings. It runs as a Claude account's login under
 * DATA_DIR (the routed one unless one is named). Registered once at startup.
 */
import { Buffer } from "node:buffer";
import { CLAUDE_SDK_PROVIDER } from "@assistant/shared";
import { CLAUDE_SDK_DISABLED_MESSAGE } from "./harnesses/claudeModelResolution.ts";
import { runOneShot } from "./harnesses/oneShot.ts";
import { PDF_MIME, setPdfClaudeFallback } from "./documentConversion.ts";
import { getSettings } from "./settings.ts";
import { listCredentialProfiles } from "./credentialProfiles.ts";
import { ModelUnavailableOnAccountError } from "./settingsModelSlots.ts";

const SYSTEM_PROMPT = `You transcribe a PDF document into clean, faithful GitHub-flavored Markdown.

- Reproduce the document's text and structure: headings, paragraphs, lists, and tables.
- Use Markdown tables for tabular data and preserve reading order across columns/pages.
- Do not summarize, translate, editorialize, or invent content that is not in the document.
- Omit page furniture (running headers/footers, page numbers) unless it carries meaning.
- Output only the Markdown transcription, with no preamble or commentary.`;

const USER_PROMPT =
  "Transcribe the attached PDF document to Markdown, following the rules exactly.";
const NO_CLAUDE_ACCOUNT =
  "No Claude account is configured. Add or sign in to a Claude account in Settings > Accounts, then retry.";

/** Register the Claude document-block fallback used for scanned/image PDFs. */
export function registerPdfClaudeFallback(): void {
  setPdfClaudeFallback(async ({ bytes }) => {
    const appSettings = getSettings();
    const settings = appSettings.pdfConversion;
    if (!settings.fallbackEnabled) return null;
    if (!appSettings.claudeSdk.enabled)
      return { unavailable: CLAUDE_SDK_DISABLED_MESSAGE };
    if (
      !listCredentialProfiles().some((profile) => profile.provider === "claude")
    )
      return { unavailable: NO_CLAUDE_ACCOUNT };
    let run: Awaited<ReturnType<typeof runOneShot>>;
    try {
      run = await runOneShot({
        model: { provider: CLAUDE_SDK_PROVIDER, modelId: settings.modelId },
        thinkingLevel: settings.thinkingLevel,
        credentialProfileId: settings.credentialProfileId,
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
    } catch (err) {
      // PA refused before any provider call (the Claude SDK is off, or no
      // account can run the model): the conversion degrades and says why.
      if (err instanceof ModelUnavailableOnAccountError)
        return { unavailable: err.message };
      throw err;
    }
    const { text, failure } = run;
    // A transcript cut short by an error must not stand in for the document.
    if (failure !== undefined) throw new Error(failure);
    const markdown = text.trim();
    return markdown ? { markdown } : null;
  });
}
