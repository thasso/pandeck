// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayApp } from "./GatewayApp.tsx";

/**
 * The gateway's page against its own API (Task-1402): what `/api/me` and the
 * callback's `?signin=` code show, and how sign-out asks.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement;
const fetchMock = vi.fn<typeof fetch>();
const EPOCH = "e".repeat(32);

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function render(path: string, reload = () => {}): Promise<void> {
  window.history.replaceState(null, "", path);
  await act(async () => {
    root = createRoot(host);
    root.render(<GatewayApp reload={reload} />);
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

test("signed out: a sign-in link to the gateway's own login", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/");
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/me",
    expect.objectContaining({ credentials: "same-origin" }),
  );
  const link = host.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/auth/login");
  expect(link?.textContent).toBe("Sign in");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("the page scrolls itself: the shared stylesheet clips html, body and #root", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/");
  const page = host.firstElementChild;
  expect(page?.classList.contains("h-full")).toBe(true);
  expect(page?.classList.contains("overflow-y-auto")).toBe(true);
});

test("a fixed sentence per sign-in code, and for an unknown one", async () => {
  const expected: Record<string, string> = {
    denied: "This account may not use this gateway.",
    expired: "The sign-in took too long",
    failed: "The sign-in did not complete.",
    busy: "too many sign-ins",
    "<b>provider says no</b>": "The sign-in did not complete.",
  };
  for (const [code, text] of Object.entries(expected)) {
    fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
    await render(`/?signin=${encodeURIComponent(code)}`);
    expect(host.textContent).toContain(text);
    expect(host.textContent).not.toContain("provider says no");
    act(() => root?.unmount());
  }
});

test("signed in: the email, and sign-out posts with the header", async () => {
  fetchMock.mockResolvedValueOnce(
    answer(200, {
      userId: "u_abc",
      email: "person@example.org",
      label: "person@example.org",
    }),
  );
  const reload = vi.fn();
  await render("/", reload);
  expect(host.textContent).toContain("person@example.org");
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "Sign out",
  );
  await act(async () => button!.click());
  expect(fetchMock).toHaveBeenLastCalledWith("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-gateway-ui": "1" },
  });
  expect(reload).toHaveBeenCalledOnce();
});

test("a 503 or a malformed answer shows the unavailable state", async () => {
  for (const response of [
    answer(503, { error: "unavailable" }),
    answer(200, { userId: 7 }),
  ]) {
    fetchMock.mockResolvedValueOnce(response);
    await render("/");
    expect(host.textContent).toContain("The gateway cannot answer right now.");
    expect(host.querySelector("a")).toBeNull();
    act(() => root?.unmount());
  }
});

test("signed in: Accounts, Jira, Slack, GitHub, Clients and Requests each load; signed out none is fetched", async () => {
  const paths = () => fetchMock.mock.calls.map(([input]) => String(input));
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/");
  expect(paths()).toEqual(["/api/me"]);
  act(() => root?.unmount());

  fetchMock.mockReset();
  fetchMock.mockImplementation((input) => {
    switch (String(input)) {
      case "/api/me":
        return Promise.resolve(
          answer(200, { userId: "u1", email: "p@example.org", label: "p" }),
        );
      case "/api/accounts":
        return Promise.resolve(answer(200, { accounts: [] }));
      case "/api/integrations/atlassian":
        return Promise.resolve(
          answer(200, {
            connected: true,
            site: "x.atlassian.net",
            email: "p@example.org",
            connectWith: "token",
          }),
        );
      case "/api/integrations/slack":
        return Promise.resolve(
          answer(200, { offered: true, connected: true, teamName: "Fake" }),
        );
      case "/api/integrations/github":
        return Promise.resolve(
          answer(200, { offered: true, connected: true, login: "fake-login" }),
        );
      case "/api/clients":
        return Promise.resolve(
          answer(200, {
            clients: [
              { id: "c1", label: "Laptop", createdAt: 1, mcpToken: false },
            ],
          }),
        );
      case "/api/requests?after=0":
        return Promise.resolve(answer(200, { epoch: EPOCH, requests: [] }));
      default:
        return Promise.resolve(answer(404, {}));
    }
  });
  host = document.createElement("div");
  document.body.append(host);
  await render("/");
  await act(async () => {});
  expect(paths().sort()).toEqual([
    "/api/accounts",
    "/api/clients",
    "/api/integrations/atlassian",
    "/api/integrations/github",
    "/api/integrations/slack",
    "/api/me",
    "/api/requests?after=0",
  ]);
  const sections = [...host.querySelectorAll("section")].map((section) =>
    section.getAttribute("aria-label"),
  );
  expect(sections).toEqual([
    "Accounts",
    "Jira",
    "Slack",
    "GitHub",
    "Clients",
    "Requests",
  ]);
  expect(host.textContent).toContain("Connected to Fake");
  expect(host.textContent).toContain("Connected as fake-login");
  expect(host.textContent).toContain("x.atlassian.net");
  expect(host.textContent).toContain("Laptop");
});

// --- the Atlassian callback's code (Task-1411, AC8) --------------------------

/**
 * Signed in with nothing stored on a gateway that signs in with Atlassian,
 * and answers `slack` and `github` for their statuses (by default, neither
 * offered).
 */
function signedInRoutes(
  slack: unknown = { offered: false, connected: false },
  github: unknown = { offered: false, connected: false },
) {
  fetchMock.mockImplementation((input) => {
    switch (String(input)) {
      case "/api/me":
        return Promise.resolve(
          answer(200, {
            userId: "u_abc",
            email: "p@example.org",
            label: "p@example.org",
          }),
        );
      case "/api/accounts":
        return Promise.resolve(answer(200, { accounts: [] }));
      case "/api/integrations/atlassian":
        return Promise.resolve(
          answer(200, { connected: false, connectWith: "oauth" }),
        );
      case "/api/integrations/slack":
        return Promise.resolve(answer(200, slack));
      case "/api/integrations/github":
        return Promise.resolve(answer(200, github));
      case "/api/clients":
        return Promise.resolve(answer(200, { clients: [] }));
      case "/api/requests?after=0":
        return Promise.resolve(answer(200, { epoch: EPOCH, requests: [] }));
      default:
        return Promise.resolve(answer(404, { error: "not_found" }));
    }
  });
}

const jiraSection = () => host.querySelector('section[aria-label="Jira"]');

test("signed in, a kept ?atlassian= code shows in the Jira section and leaves the address", async () => {
  signedInRoutes();
  await render("/?atlassian=site_ambiguous");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(jiraSection()?.textContent).toContain(
    "Your Atlassian sign-in includes more than one Jira site",
  );
});

test("an unknown ?atlassian= value is dropped unshown and leaves the address", async () => {
  signedInRoutes();
  await render("/?atlassian=bogus");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(jiraSection()).not.toBeNull();
  expect(host.textContent).not.toContain("bogus");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("signed out, ?atlassian=signed_out shows on the sign-in card; other codes do not", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?atlassian=signed_out");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.textContent).toContain(
    "Your gateway session ended before Atlassian answered. Sign in, then use Sign in with Atlassian again.",
  );
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/auth/login");
  act(() => root?.unmount());

  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?atlassian=site_missing");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// --- the Slack callback's code (Task-1453, AC7) ------------------------------

const slackSection = () => host.querySelector('section[aria-label="Slack"]');
const SLACK_OFFERED = { offered: true, connected: false };

test("without Slack offered no Slack section renders", async () => {
  signedInRoutes();
  await render("/");
  expect(jiraSection()).not.toBeNull();
  expect(slackSection()).toBeNull();
});

test("signed in, ?slack=team_mismatch shows its text in the Slack section and leaves the address", async () => {
  signedInRoutes(SLACK_OFFERED);
  await render("/?slack=team_mismatch");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(slackSection()?.textContent).toContain(
    "You signed in to a different Slack workspace than this gateway's.",
  );
  expect(jiraSection()?.querySelector('[role="alert"]')).toBeNull();
});

test("an unknown ?slack= value is dropped unshown and leaves the address", async () => {
  signedInRoutes(SLACK_OFFERED);
  await render("/?slack=%3Cb%3Eslack%20says%20no%3C%2Fb%3E");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(slackSection()).not.toBeNull();
  expect(host.textContent).not.toContain("slack says no");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("?atlassian=denied&slack=failed keeps both codes, each in its own section, and the rest of the address", async () => {
  signedInRoutes(SLACK_OFFERED);
  await render("/?atlassian=denied&keep=1&slack=failed#x");
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe("/?keep=1#x");
  expect(jiraSection()?.textContent).toContain(
    "Access was not granted on Atlassian's page",
  );
  expect(jiraSection()?.textContent).not.toContain("Slack");
  expect(slackSection()?.textContent).toContain(
    "The sign-in with Slack did not finish.",
  );
  expect(slackSection()?.textContent).not.toContain("Atlassian");
});

test("signed out, ?slack=signed_out shows the Slack text on the sign-in card; other codes do not", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?slack=signed_out");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.textContent).toContain(
    "Your gateway session ended before Slack answered. Sign in, then use Sign in with Slack again.",
  );
  expect(host.textContent).not.toContain("Atlassian");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/auth/login");
  act(() => root?.unmount());

  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?slack=expired");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

// --- the GitHub callback's code (Task-1445) -----------------------------------

const githubSection = () => host.querySelector('section[aria-label="GitHub"]');
const GITHUB_OFFERED = { offered: true, connected: false };

test("without GitHub offered no GitHub section renders", async () => {
  signedInRoutes();
  await render("/");
  expect(jiraSection()).not.toBeNull();
  expect(githubSection()).toBeNull();
});

test("signed in, GitHub offered and not connected shows not connected and Connect GitHub", async () => {
  signedInRoutes(undefined, GITHUB_OFFERED);
  await render("/");
  expect(githubSection()?.textContent).toContain("GitHub is not connected.");
  expect(githubSection()?.textContent).toContain("Connect GitHub");
  expect(githubSection()?.textContent).toContain("Check repository access");
});

test("signed in, ?github=not_configured shows its text in the GitHub section and leaves the address", async () => {
  signedInRoutes(undefined, GITHUB_OFFERED);
  await render("/?github=not_configured");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(githubSection()?.textContent).toContain(
    "This gateway is not set up to finish GitHub connections.",
  );
  expect(jiraSection()?.querySelector('[role="alert"]')).toBeNull();
});

test("an unknown ?github= value is dropped unshown and leaves the address", async () => {
  signedInRoutes(undefined, GITHUB_OFFERED);
  await render("/?github=%3Cb%3Egithub%20says%20no%3C%2Fb%3E");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(githubSection()).not.toBeNull();
  expect(host.textContent).not.toContain("github says no");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("?slack=failed&github=denied keeps both codes, each in its own section, and the rest of the address", async () => {
  signedInRoutes({ offered: true, connected: false }, GITHUB_OFFERED);
  await render("/?slack=failed&keep=1&github=denied#x");
  expect(
    window.location.pathname + window.location.search + window.location.hash,
  ).toBe("/?keep=1#x");
  expect(githubSection()?.textContent).toContain(
    "Access was not granted on GitHub's page",
  );
  expect(githubSection()?.textContent).not.toContain("Slack");
  expect(slackSection()?.textContent).toContain(
    "The sign-in with Slack did not finish.",
  );
  expect(slackSection()?.textContent).not.toContain("GitHub");
});

test("signed out, ?github=signed_out shows the GitHub text on the sign-in card; other codes do not", async () => {
  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?github=signed_out");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.textContent).toContain(
    "Your gateway session ended before GitHub answered. Sign in, then use Connect GitHub again.",
  );
  expect(host.textContent).not.toContain("Slack");
  expect(host.querySelector("a")?.getAttribute("href")).toBe("/auth/login");
  act(() => root?.unmount());

  fetchMock.mockResolvedValueOnce(answer(401, { error: "signed_out" }));
  await render("/?github=expired");
  expect(window.location.pathname + window.location.search).toBe("/");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
