// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { AppSettings } from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import { GoogleWorkspaceSection } from "./SettingsPage.tsx";

const start = vi.hoisted(() => vi.fn());
vi.mock("../lib/googleOAuth.ts", () => ({ startGoogleOAuth: start }));
afterEach(() => vi.restoreAllMocks());

function render() {
  const onTestGoogle = vi.fn();
  const view = mount(
    <GoogleWorkspaceSection
      settings={
        {
          google: {
            enabled: false,
            oauthClientConfigured: true,
            refreshTokenConfigured: false,
            gmailMinutesLabelName: "Minutes",
          },
        } as AppSettings
      }
      status={null}
      onUpdateGoogle={vi.fn()}
      onSaveAndTestGoogle={vi.fn()}
      onTestGoogle={onTestGoogle}
    />,
  );
  const button = [...view.container.querySelectorAll("button")].find(
    (el) => el.textContent === "Sign in with Google",
  )!;
  return { ...view, button, onTestGoogle };
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

test("native sign-in waits for return, then checks without a popup handle", async () => {
  start.mockResolvedValue({ popup: null, external: true });
  const view = render();
  await click(view.button);
  expect(view.container.textContent).toContain(
    "Complete Google sign-in in your browser",
  );
  expect(view.onTestGoogle).not.toHaveBeenCalled();
  await act(() => window.dispatchEvent(new Event("focus")));
  expect(view.onTestGoogle).toHaveBeenCalledOnce();
  expect(view.container.textContent).toContain(
    "Checking Google Workspace authorization",
  );
});

test("iOS visibility return checks authorization even without a focus event", async () => {
  start.mockResolvedValue({ popup: null, external: true });
  const view = render();
  await click(view.button);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(view.onTestGoogle).not.toHaveBeenCalled();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(view.onTestGoogle).toHaveBeenCalledOnce();
});

test("blocked sign-in shows a local error without pretending to check", async () => {
  start.mockRejectedValue(
    new Error("Allow popups for this site, then try Google sign-in again."),
  );
  const view = render();
  await click(view.button);
  expect(view.container.textContent).toContain("Allow popups");
  expect(view.container.textContent).not.toContain(
    "Checking Google Workspace authorization",
  );
  expect(view.onTestGoogle).not.toHaveBeenCalled();
  expect(view.button.disabled).toBe(false);
});

test("pending consent preparation disables repeat clicks", async () => {
  let finish!: (value: { popup: null; external: boolean }) => void;
  start.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render();
  await click(view.button);
  expect(view.button.disabled).toBe(true);
  expect(view.button.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish({ popup: null, external: true }));
  expect(view.button.disabled).toBe(false);
});
