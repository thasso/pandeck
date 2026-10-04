// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type {
  ApprovalCard as ApprovalCardData,
  SettingsInputApprovalBody,
} from "@assistant/shared";
import { ApprovalCard } from "./ApprovalCard.tsx";

const accountsApi = vi.hoisted(() => ({
  fetchCredentialProfiles: vi.fn(),
  startOpenAiProfileLogin: vi.fn(async () => {}),
}));
vi.mock("../lib/credentialProfiles.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/credentialProfiles.ts")>()),
  ...accountsApi,
}));
vi.mock("./ClaudeLoginTerminal.tsx", () => ({
  ClaudeLoginTerminal: ({ profile }: { profile: { name: string } }) => (
    <div role="dialog">Claude login for {profile.name}</div>
  ),
}));

/**
 * Settings-input cards (Task-729): the user types a secret or connects an
 * account; the value leaves only inside the approving decision.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

function buttonLabels(): string[] {
  return [...container!.querySelectorAll("button")].map((element) =>
    (element.textContent ?? "").trim(),
  );
}

function click(label: string): void {
  const match = [...container!.querySelectorAll("button")].find(
    (element) => (element.textContent ?? "").trim() === label,
  );
  expect(match, `no button labelled ${label}`).toBeDefined();
  act(() => {
    match!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Type into a controlled input the way a browser does. */
function type(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-native-shell");
});

function card(body: Partial<SettingsInputApprovalBody>): ApprovalCardData {
  return {
    renderKind: "approval",
    id: "ap_settings",
    sessionId: "session-1",
    kind: "settingsInput",
    status: "pending",
    title: "Enter Personal access token",
    createdAt: 0,
    body: {
      kind: "settingsInput",
      path: "github.token",
      label: "Personal access token",
      section: "github",
      mode: "secret",
      wasConfigured: false,
      ...body,
    },
  };
}

test("a secret is sent only with the decision and leaves the field", () => {
  const onResolve = vi.fn();
  render(
    <ApprovalCard
      approval={card({ reason: "To read your pull requests." })}
      onResolve={onResolve}
    />,
  );
  expect(container!.textContent).toContain("To read your pull requests.");
  // Its own controls replace the generic footer, and nothing grants it.
  expect(buttonLabels()).toEqual(["Dismiss", "Save"]);

  const input = container!.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  expect(input.getAttribute("autocomplete")).toBe("off");
  type(input, "  typed-fixture  ");
  click("Save");

  expect(onResolve).toHaveBeenCalledWith("ap_settings", "approved", {
    kind: "settingsInput",
    value: "typed-fixture",
  });
  expect(input.value).toBe("");
});

test("Save waits for a value", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={card({})} onResolve={onResolve} />);
  click("Save");
  expect(onResolve).not.toHaveBeenCalled();
});

test("Dismiss rejects the card", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={card({})} onResolve={onResolve} />);
  click("Dismiss");
  expect(onResolve).toHaveBeenCalledWith("ap_settings", "rejected");
});

test("a connection opens the server's sign-in route", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
  render(
    <ApprovalCard
      approval={card({
        path: "google.connection",
        label: "Google account connection",
        section: "google",
        mode: "connect",
      })}
      onResolve={vi.fn()}
    />,
  );
  expect(container!.querySelector("input")).toBeNull();
  await act(async () => click("Connect"));
  expect(open).toHaveBeenCalledOnce();
  expect(String(open.mock.calls[0]![0])).toMatch(
    /\/api\/google\/oauth\/start$/,
  );
  expect(buttonLabels()).toContain("Open again");
});

test("an iOS Google connection card opens consent in the system browser", async () => {
  document.documentElement.setAttribute("data-native-shell", "ios");
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state";
  const fetch = vi.fn().mockResolvedValue(Response.json({ url }));
  vi.stubGlobal("fetch", fetch);
  const assign = vi.fn();
  vi.stubGlobal("location", {
    origin: location.origin,
    hostname: location.hostname,
    protocol: location.protocol,
    assign,
  });
  const open = vi.spyOn(window, "open");
  const onResolve = vi.fn();
  render(
    <ApprovalCard
      approval={card({
        path: "google.connection",
        label: "Google account connection",
        section: "google",
        mode: "connect",
      })}
      onResolve={onResolve}
    />,
  );
  await act(async () => click("Connect"));
  expect(fetch).toHaveBeenCalledWith(
    expect.stringMatching(/\/api\/google\/oauth\/prepare$/),
    expect.objectContaining({ method: "POST" }),
  );
  expect(assign).toHaveBeenCalledExactlyOnceWith(url);
  expect(open).not.toHaveBeenCalled();
  expect(buttonLabels()).toContain("Open again");
  expect(onResolve).not.toHaveBeenCalled();
});

test("a Google connection card reports a blocked popup without claiming it opened", async () => {
  vi.spyOn(window, "open").mockReturnValue(null);
  render(
    <ApprovalCard
      approval={card({
        path: "google.connection",
        section: "google",
        mode: "connect",
      })}
      onResolve={vi.fn()}
    />,
  );
  await act(async () => click("Connect"));
  expect(container!.textContent).toContain("Allow popups");
  expect(buttonLabels()).toContain("Connect");
  expect(buttonLabels()).not.toContain("Open again");
});

test("a resolved card shows its outcome and no controls", () => {
  render(
    <ApprovalCard
      approval={{
        ...card({}),
        status: "executed",
        resultSummary: "Personal access token saved.",
      }}
    />,
  );
  expect(container!.textContent).toContain("Personal access token saved.");
  expect(container!.querySelector("input")).toBeNull();
  expect(buttonLabels()).toEqual([]);
});

test("Dismiss empties the field before it rejects", () => {
  const onResolve = vi.fn();
  render(<ApprovalCard approval={card({})} onResolve={onResolve} />);
  const input = container!.querySelector<HTMLInputElement>(
    'input[type="password"]',
  )!;
  type(input, "typed-fixture");
  click("Dismiss");
  expect(input.value).toBe("");
  expect(onResolve).toHaveBeenCalledWith("ap_settings", "rejected");
});

test("a card that stops waiting drops what was typed", () => {
  render(<ApprovalCard approval={card({})} onResolve={vi.fn()} />);
  type(
    container!.querySelector<HTMLInputElement>('input[type="password"]')!,
    "typed-fixture",
  );
  // Replaced by a newer card: the field, and its value, are gone.
  act(() =>
    root!.render(
      <ApprovalCard
        approval={{ ...card({}), status: "superseded" }}
        onResolve={vi.fn()}
      />,
    ),
  );
  expect(container!.querySelector("input")).toBeNull();
  // Even if it waited again, nothing typed before comes back.
  act(() =>
    root!.render(<ApprovalCard approval={card({})} onResolve={vi.fn()} />),
  );
  expect(
    container!.querySelector<HTMLInputElement>('input[type="password"]')!.value,
  ).toBe("");
});

function signInCard(provider: "claude" | "openai-codex"): ApprovalCardData {
  return card({
    path: "accounts.cp_fixture",
    label: "Work account",
    section: provider === "claude" ? "claude-sdk" : "openai",
    mode: "signIn",
    account: { id: "cp_fixture", provider },
  });
}

function account(provider: "claude" | "openai-codex", setup?: object) {
  return {
    id: "cp_fixture",
    name: "Work account",
    provider,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    status: setup ? "connecting" : "disconnected",
    ...(setup ? { setup } : {}),
  };
}

test("an OpenAI sign-in shows the device link and code, and starts the login", async () => {
  accountsApi.fetchCredentialProfiles.mockResolvedValue([
    account("openai-codex", {
      path: "",
      command: "",
      detail: "",
      verificationUri: "https://example.invalid/device",
      userCode: "ABCD-1234",
    }),
  ]);
  render(
    <ApprovalCard approval={signInCard("openai-codex")} onResolve={vi.fn()} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(container!.textContent).toContain("ABCD-1234");
  expect(
    container!.querySelector('a[href="https://example.invalid/device"]'),
  ).not.toBeNull();
  click("Sign in again");
  expect(accountsApi.startOpenAiProfileLogin).toHaveBeenCalledWith(
    "cp_fixture",
  );
});

test("a Claude sign-in opens the official login terminal", async () => {
  accountsApi.fetchCredentialProfiles.mockResolvedValue([account("claude")]);
  render(<ApprovalCard approval={signInCard("claude")} onResolve={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  click("Sign in");
  // A viewport modal: rendered at the document root, outside the transcript row.
  expect(container!.textContent).not.toContain("Claude login");
  expect(document.body.textContent).toContain("Claude login for Work account");
});

function signInButton(): HTMLButtonElement {
  return [...container!.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Sign in"),
  ) as HTMLButtonElement;
}

test("a failed login shows the provider's error to the user", async () => {
  accountsApi.fetchCredentialProfiles.mockResolvedValue([
    {
      ...account("openai-codex"),
      status: "error",
      error: "Device code expired.",
    },
  ]);
  render(
    <ApprovalCard approval={signInCard("openai-codex")} onResolve={vi.fn()} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(container!.textContent).toContain("Device code expired.");
});

test("a missing or disabled account says so and cannot start a login", async () => {
  accountsApi.fetchCredentialProfiles.mockResolvedValue([]);
  render(<ApprovalCard approval={signInCard("claude")} onResolve={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(container!.textContent).toContain("no longer exists");
  expect(signInButton().disabled).toBe(true);
  act(() => root?.unmount());
  container?.remove();

  accountsApi.fetchCredentialProfiles.mockResolvedValue([
    { ...account("claude"), enabled: false },
  ]);
  render(<ApprovalCard approval={signInCard("claude")} onResolve={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(container!.textContent).toContain("disabled");
  expect(signInButton().disabled).toBe(true);
});
