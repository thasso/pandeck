// @vitest-environment jsdom
/**
 * `CopyableText` (Task-1405): the login dialog's link copy, moved to a shared
 * leaf the gateway page also uses for a one-time code or MCP token.
 */
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { mount } from "../../test/mount.tsx";
import { CopyableText } from "./CopyableText.tsx";

/** jsdom has no clipboard, like a page served over plain http. */
function withClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}
afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
});

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
  undefined;

function render() {
  return mount(
    <CopyableText
      value="pgmcp_fake"
      label="MCP token"
      copyLabel="Copy token"
      copiedLabel="Token copied"
    />,
  );
}

test("Copy writes the value and confirms in place for two seconds", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn(() => Promise.resolve());
  withClipboard(writeText);
  render();
  await act(async () => button("Copy token")!.click());
  expect(writeText).toHaveBeenCalledWith("pgmcp_fake");
  expect(button("Token copied")).toBeDefined();
  act(() => {
    vi.advanceTimersByTime(2_000);
  });
  expect(button("Copy token")).toBeDefined();
});

test("a refused write shows no confirmation", async () => {
  withClipboard(() => Promise.reject(new Error("denied")));
  render();
  await act(async () => button("Copy token")!.click());
  expect(button("Token copied")).toBeUndefined();
});

test("without a clipboard the button is hidden and the value stays selectable", () => {
  render();
  expect(button("Copy token")).toBeUndefined();
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="MCP token"]',
  );
  expect(input?.readOnly).toBe(true);
  expect(input?.value).toBe("pgmcp_fake");
});
