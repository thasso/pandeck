import { nativeShellPlatform, openNativeGoogleConsent } from "./nativeShell.ts";
import { authHeaders, serverHttpOrigin } from "./serverOrigin.ts";

/** Google consent must run in a browser, never inside a native webview. */
export async function startGoogleOAuth(): Promise<{
  popup: Window | null;
  external: boolean;
}> {
  if (nativeShellPlatform() === null) {
    // Keep this synchronous with the click so Safari preserves user activation.
    const popup = window.open(
      `${serverHttpOrigin()}/api/google/oauth/start`,
      "assistant-google-oauth",
      "popup,width=560,height=760",
    );
    if (!popup)
      throw new Error(
        "Allow popups for this site, then try Google sign-in again.",
      );
    return { popup, external: false };
  }

  // A same-origin popup is dropped on iOS. Resolve consent before handing it
  // to the typed native helper, without opening an embedded sign-in page.
  try {
    const response = await fetch(
      `${serverHttpOrigin()}/api/google/oauth/prepare`,
      { method: "POST", headers: authHeaders() },
    );
    if (!response.ok) throw new Error("Sign-in preparation failed.");
    const data = (await response.json()) as { url?: unknown } | null;
    if (typeof data?.url !== "string") throw new Error("Missing consent URL.");
    openNativeGoogleConsent(data.url);
    return { popup: null, external: true };
  } catch {
    throw new Error("Could not start Google sign-in. Please try again.");
  }
}
