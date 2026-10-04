// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { startGoogleOAuth } from "./googleOAuth.ts";

function nativeBrowser(platform: string) {
  document.documentElement.setAttribute("data-native-shell", platform);
  const assign = vi.fn();
  vi.stubGlobal("location", {
    origin: location.origin,
    hostname: location.hostname,
    protocol: location.protocol,
    assign,
  });
  return assign;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-native-shell");
  delete window.__ASSISTANT_TOKEN__;
});

test("browser popup opens before the click's user activation can expire", async () => {
  const popup = {} as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(popup);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const pending = startGoogleOAuth();
  expect(open).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/google\/oauth\/start$/),
    "assistant-google-oauth",
    "popup,width=560,height=760",
  );
  expect(await pending).toEqual({ popup, external: false });
  expect(fetch).not.toHaveBeenCalled();
});

test("blocked browser popup is an error, not an authorization check", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  await expect(startGoogleOAuth()).rejects.toThrow("Allow popups");
});

for (const shell of ["ios", "macos", "desktop"]) {
  test(`${shell} prepares authenticated consent and uses foreign navigation, not a popup`, async () => {
    const assign = nativeBrowser(shell);
    window.__ASSISTANT_TOKEN__ = "fixture-token";
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state";
    const fetch = vi.fn().mockResolvedValue(Response.json({ url }));
    vi.stubGlobal("fetch", fetch);
    const open = vi.spyOn(window, "open");
    expect(await startGoogleOAuth()).toEqual({ popup: null, external: true });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/google\/oauth\/prepare$/),
      { method: "POST", headers: { "x-assistant-token": "fixture-token" } },
    );
    expect(assign).toHaveBeenCalledExactlyOnceWith(url);
    expect(assign.mock.calls[0]![0]).not.toContain("fixture-token");
    expect(open).not.toHaveBeenCalled();
  });
}

test("failed preparation does not open a browser or expose the response", async () => {
  const assign = nativeBrowser("ios");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("private details", { status: 400 })),
  );
  await expect(startGoogleOAuth()).rejects.toThrow(
    "Could not start Google sign-in",
  );
  expect(assign).not.toHaveBeenCalled();
});

for (const url of [
  "https://foreign.example/auth",
  "https://accounts.google.com/not-consent",
  "https://user:password@accounts.google.com/o/oauth2/v2/auth",
  "not a URL",
]) {
  test(`rejects an unexpected consent target: ${url}`, async () => {
    const assign = nativeBrowser("ios");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ url })));
    await expect(startGoogleOAuth()).rejects.toThrow(
      "Could not start Google sign-in",
    );
    expect(assign).not.toHaveBeenCalled();
  });
}

for (const body of [
  "<html>private details</html>",
  "null",
  "{}",
  '{"url":12}',
]) {
  test(`malformed preparation responses produce a plain error: ${body}`, async () => {
    const assign = nativeBrowser("ios");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(startGoogleOAuth()).rejects.toThrow(
      "Could not start Google sign-in. Please try again.",
    );
    expect(assign).not.toHaveBeenCalled();
  });
}
