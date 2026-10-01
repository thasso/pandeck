// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, test, vi } from "vitest";
import {
  modelKey,
  type AppSettings,
  type CredentialProfileSummary,
  type ModelOption,
} from "@assistant/shared";
import { mount } from "../test/mount.tsx";
import {
  CredentialProfileCard,
  credentialProfilesForProvider,
  ModelsSection,
  parseSlackBrowserCurl,
} from "./SettingsPage.tsx";

const profiles = [
  {
    id: "claude-default",
    name: "Claude",
    provider: "claude",
    enabled: true,
    status: "ready",
  },
  {
    id: "default",
    name: "OpenAI",
    provider: "openai-codex",
    enabled: true,
    status: "ready",
  },
  {
    id: "openai-work",
    name: "OpenAI work",
    provider: "openai-codex",
    enabled: true,
    status: "disconnected",
  },
] as CredentialProfileSummary[];

describe("credential profile settings", () => {
  test("keeps Claude and OpenAI profile pages isolated", () => {
    expect(
      credentialProfilesForProvider(profiles, "claude").map(
        (profile) => profile.id,
      ),
    ).toEqual(["claude-default"]);
    expect(
      credentialProfilesForProvider(profiles, "openai-codex").map(
        (profile) => profile.id,
      ),
    ).toEqual(["default", "openai-work"]);
  });

  test("keeps rename and delete as icon-only top actions and gives reconnect an icon", () => {
    const profile = {
      ...profiles[0]!,
      id: "claude-private",
      name: "Claude private",
    };
    const html = renderToStaticMarkup(
      createElement(CredentialProfileCard, {
        profile,
        providerLabel: "Claude",
        connectionLabel: "Reconnect",
        onToggle: () => {},
        onConnect: () => {},
        onRename: () => {},
        onDelete: () => {},
      }),
    );
    expect(html).toContain('aria-label="Rename Claude private"');
    expect(html).toContain('aria-label="Delete Claude private"');
    expect(html).not.toContain(">Rename<");
    expect(html).not.toContain(">Delete<");
    expect(html).toMatch(
      /<svg[^>]*>[\s\S]*?<\/svg><span class="truncate">Reconnect<\/span>/,
    );
    expect(html.indexOf('aria-label="Rename Claude private"')).toBeLessThan(
      html.indexOf('role="switch"'),
    );
  });
});

describe("Slack Huddle cURL intake", () => {
  it("retains only the browser token and d cookie from huddles.history", () => {
    const parsed =
      parseSlackBrowserCurl(`curl 'https://example.slack.com/api/huddles.history?slack_route=T1&_x_version_ts=123' \\
      -H 'authorization: Bearer xoxc-browser' \\
      -H 'cookie: d=cookie-value; other=sensitive'`);

    expect(parsed.error).toBeUndefined();
    expect(parsed.patch).toEqual({
      clientToken: "xoxc-browser",
      clientCookieD: "cookie-value",
    });
    expect(parsed.found).toEqual(["browser token", "d cookie"]);
  });

  it("rejects copied requests for other private Slack APIs", () => {
    const parsed = parseSlackBrowserCurl(
      `curl 'https://example.slack.com/api/saved.list' -H 'authorization: Bearer xoxc-browser' -H 'cookie: d=cookie-value'`,
    );
    expect(parsed.error).toMatch(
      /not a copied Slack huddles\.history request/i,
    );
    expect(parsed.patch).toEqual({});
  });
});

/**
 * Settings is an END-USER surface (`components/CLAUDE.md`), so its pending
 * states say what is happening in plain words and get their motion from
 * `ui/load.tsx` — no hand-rolled spinner, no protocol or token diagnostics
 * leaking into the flow (`app/web/docs/loading-states.md`, Task-361 Phase 3d).
 */

const profile = (
  status: CredentialProfileSummary["status"],
): CredentialProfileSummary => ({
  id: "claude-default",
  name: "Claude personal",
  provider: "claude",
  enabled: true,
  status,
  createdAt: 0,
  updatedAt: 0,
});

function card(status: CredentialProfileSummary["status"]): string {
  return renderToStaticMarkup(
    <CredentialProfileCard
      profile={profile(status)}
      providerLabel="Claude"
      connectionLabel={status === "connecting" ? "Continue login" : "Connect"}
      onToggle={() => {}}
      onConnect={() => {}}
    />,
  );
}

describe("credential profile connection state", () => {
  it("spins the shared glyph while a profile is connecting", () => {
    const html = card("connecting");
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain("Continue login");
  });

  it("shows a still refresh icon when nothing is in flight", () => {
    const html = card("ready");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("Connect");
  });
});

function modelsSection(refreshing: boolean): string {
  return renderToStaticMarkup(
    <ModelsSection
      models={[]}
      settings={{ models: { hidden: [], order: [] } } as unknown as AppSettings}
      onUpdate={() => {}}
      onRefresh={() => {}}
      refreshing={refreshing}
    />,
  );
}

describe("model refresh state", () => {
  /**
   * A refresh that found nothing new answers with a list identical to the one
   * already on screen, so the spinner is the ONLY thing distinguishing a
   * working button from a dead one.
   */
  it("spins and disables the button while a refresh is out", () => {
    const html = modelsSection(true);
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).toContain('aria-busy="true"');
    // The attribute, not the `disabled:` utility classes the button always has.
    expect(html).toContain('disabled=""');
  });

  it("is idle and clickable when no refresh is in flight", () => {
    const html = modelsSection(false);
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Refresh");
  });
});

/**
 * The drag gesture itself is covered by `hooks/usePointerReorder.test.tsx`.
 * This is the join between it and the settings surface: the working copy
 * `ModelsSection` keeps while a finger is down, and the resync effect that
 * replaces that copy whenever the PERSISTED order changes. The two meet when a
 * settings echo lands mid-drag, which no test of either half alone can reach.
 */

const models: ModelOption[] = ["a", "b", "c"].map((id) => ({
  provider: "p",
  id,
  name: `Model ${id.toUpperCase()}`,
  reasoning: false,
  contextWindow: 1000,
}));

const settingsWith = (order: string[]): AppSettings =>
  ({ models: { order, hidden: [] } }) as unknown as AppSettings;

const ROW_PITCH = 30;

/** The boxes a browser would have measured; jsdom lays nothing out. */
function stubRows(list: Element) {
  for (const row of Array.from(list.children))
    row.getBoundingClientRect = function (this: Element) {
      const index = Array.from(this.parentElement!.children).indexOf(this);
      return {
        top: index * ROW_PITCH,
        bottom: index * ROW_PITCH + 20,
      } as DOMRect;
    };
}

function pointer(type: string, y: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    buttons: 1,
    isPrimary: true,
    clientX: 0,
    clientY: y,
  });
  return event;
}

function render(onUpdate: (patch: Partial<AppSettings>) => void) {
  const { container, render: draw } = mount();
  const show = (settings: AppSettings) =>
    draw(
      <ModelsSection
        models={models}
        settings={settings}
        onUpdate={onUpdate}
        onRefresh={() => {}}
        refreshing={false}
      />,
    );
  show(settingsWith(models.map(modelKey)));
  const list = container.querySelector("ul")!;
  stubRows(list);
  return {
    container,
    show,
    list,
    order: () =>
      Array.from(list.querySelectorAll("li button[aria-label^='Reorder']")).map(
        (grip) => grip.getAttribute("aria-label")!.slice(8, 15).trim(),
      ),
    grip: (index: number) =>
      list.querySelectorAll<HTMLButtonElement>("button[aria-label^='Reorder']")[
        index
      ]!,
  };
}

describe("model order settings", () => {
  it("saves the dragged arrangement as the visible order", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(pointer("pointerdown", 5));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", 70));
    });
    act(() => {
      window.dispatchEvent(pointer("pointerup", 70));
    });

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0]).toEqual({
      models: { order: ["p:b", "p:c", "p:a"], hidden: [] },
    });
  });

  /**
   * The persisted order changing mid-drag (an echo from another surface, a
   * refresh) resyncs the working copy. That list is the authoritative one, so
   * the release must not save the arrangement the finger was building over it.
   */
  it("drops a drag that a settings change interrupts", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(pointer("pointerdown", 5));
    });
    act(() => {
      window.dispatchEvent(pointer("pointermove", 70));
    });
    expect(view.order()).toEqual(["Model B", "Model C", "Model A"]);

    // The same models, ordered by someone else.
    view.show(settingsWith(["p:c", "p:b", "p:a"]));
    stubRows(view.list);
    expect(view.order()).toEqual(["Model C", "Model B", "Model A"]);

    act(() => {
      window.dispatchEvent(pointer("pointermove", 5));
      window.dispatchEvent(pointer("pointerup", 5));
    });
    expect(view.order()).toEqual(["Model C", "Model B", "Model A"]);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("announces where a keyboard move put the model", () => {
    const onUpdate = vi.fn();
    const view = render(onUpdate);

    act(() => {
      view.grip(0).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onUpdate.mock.calls[0]![0]).toEqual({
      models: { order: ["p:b", "p:a", "p:c"], hidden: [] },
    });
    expect(view.container.querySelector("[aria-live]")!.textContent).toBe(
      "Model A moved to position 2 of 3",
    );
  });
});
