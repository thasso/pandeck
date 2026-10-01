import type { DocumentTarget } from "@assistant/shared/documentTargets";
import { mintFileGrantUrl } from "./directFiles.ts";
import { nativeShellPlatform, openNativeServedFile } from "./nativeShell.ts";
import { servedFileKind } from "./servedFiles.ts";
import { showToast } from "./toast.ts";

export type ExternalDocumentIntent = "open" | "download";

/** Whether a safe source-scoped OS-browser URL can be minted in this runtime. */
export function externalDocumentActionEnabled(
  _target: DocumentTarget,
): boolean {
  return true;
}

/**
 * Open/download without navigating a Tauri webview to an authenticated API
 * URL. Every typed source mints the minimum token-free capability first.
 */
export async function runExternalDocumentAction(
  target: DocumentTarget,
  intent: ExternalDocumentIntent,
): Promise<void> {
  const native = nativeShellPlatform() !== null;
  // Reserve the browser tab while the click still carries user activation;
  // minting is asynchronous and opening one afterwards is popup-blocked.
  const tab = native ? null : openBrowserPlaceholder();
  try {
    const scope =
      intent === "open" && servedFileKind(target.path) === "html"
        ? "directory"
        : "file";
    const delivery = intent === "download" ? "attachment" : "inline";
    const grant = await mintFileGrantUrl(target, undefined, scope, delivery);
    if (native) await openNativeServedFile(grant.url);
    else if (tab) tab.location.replace(grant.url);
    else window.open(grant.url, "_self");
  } catch (error) {
    tab?.close();
    showToast(
      error instanceof Error
        ? error.message
        : "Could not open this file in your browser.",
      { tone: "error" },
    );
  }
}

function openBrowserPlaceholder(): Window | null {
  const tab = window.open("", "_blank");
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      // Read-only in some engines; the grant holds no app token either way.
    }
  }
  return tab;
}
