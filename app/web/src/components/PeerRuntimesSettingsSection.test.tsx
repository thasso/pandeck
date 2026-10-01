// @vitest-environment jsdom
/**
 * Approved peer runtimes, the user's surface ([Task-595](pa://task/595)).
 *
 * The section's job is to make an approval legible and reversible, so what is
 * asserted is: a row states the exact runtime it approves, a row that can no
 * longer run says WHY instead of quietly repairing itself, and adding, enabling
 * and removing all save the whole ordered list.
 */
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  MAX_PEER_RUNTIME_DESCRIPTION_CHARS,
  type AccountModelOption,
  type AppSettings,
  type CredentialProfileSummary,
  type PeerSpawnRuntime,
} from "@assistant/shared";
import { CredentialProfilesContext } from "./AgentModelFields.tsx";
import { PeerRuntimesSettingsSection } from "./PeerRuntimesSettingsSection.tsx";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const models: AccountModelOption[] = [
  {
    provider: "claude-sdk",
    id: "opus",
    name: "Claude Opus",
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high", "xhigh"],
    contextWindow: 200_000,
    credentialProfileId: "acct-claude",
    accountName: "Personal Claude",
  },
];

const runtime = (patch: Partial<PeerSpawnRuntime> = {}): PeerSpawnRuntime => ({
  id: "pr_1",
  name: "Opus reviewer",
  relativeCost: "high",
  description: "Use for strict final reviews.",
  credentialProfileId: "acct-claude",
  provider: "claude-sdk",
  modelId: "opus",
  thinkingLevel: "medium",
  enabled: true,
  ...patch,
});

function render(
  rows: PeerSpawnRuntime[],
  onUpdate = vi.fn(),
  options: {
    models?: AccountModelOption[];
    profiles?: CredentialProfileSummary[];
    /** Mount the way `main.tsx` does, which replays mount effects in dev. */
    strict?: boolean;
  } = {},
) {
  const settings = {
    peerSpawnRuntimes: rows,
    sessionPeerPromptMaxHops: 50,
  } as AppSettings;
  const tree = (
    <CredentialProfilesContext.Provider value={options.profiles ?? []}>
      <PeerRuntimesSettingsSection
        models={options.models ?? models}
        settings={settings}
        onUpdate={onUpdate}
      />
    </CredentialProfilesContext.Provider>
  );
  act(() => {
    root?.render(options.strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return onUpdate;
}

const disabledAccount: CredentialProfileSummary = {
  id: "acct-claude",
  name: "Personal Claude",
  provider: "claude",
  enabled: false,
  createdAt: 0,
  updatedAt: 0,
  status: "ready",
};

const text = () => container?.textContent ?? "";

/**
 * Each row's Name input, in row order: the field a revealed row puts the
 * cursor in, and the first text input a row renders.
 */
const nameInputs = () =>
  [...(container?.querySelectorAll("li") ?? [])].map((row) =>
    row.querySelector<HTMLInputElement>('input[type="text"]'),
  );

/** What `scrollIntoView` was called on, so a test can name the element. */
function trackScrolls() {
  const previous = Element.prototype.scrollIntoView;
  const targets: Element[] = [];
  Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
    targets.push(this);
  };
  return {
    targets,
    restore: () => {
      Element.prototype.scrollIntoView = previous;
    },
  };
}

/** The thinking picker's trigger, which is what states the current selection. */
const thinkingTrigger = () =>
  [...(container?.querySelectorAll("button") ?? [])].find((node) =>
    node.getAttribute("title")?.startsWith("Thinking level"),
  );

test("changing the loop guard saves the runtime hop limit", () => {
  const onUpdate = render([]);
  const input = container?.querySelector<HTMLInputElement>(
    'input[type="number"]',
  );

  expect(input?.value).toBe("50");
  if (!input) throw new Error("missing hop-limit input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "75");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(onUpdate).toHaveBeenCalledWith({ sessionPeerPromptMaxHops: 75 });
  expect(text()).toContain("Your next prompt closes the chain");
});

test("an empty roster says agents must ask for every batch", () => {
  render([]);

  expect(text()).toContain("No approved runtimes");
});

test("a row shows its inferred family, user-set cost and selection hint", () => {
  render([runtime()]);

  expect(text()).toContain("Family: claude");
  expect(text()).toContain("Higher cost");
  const description = [
    ...(container?.querySelectorAll<HTMLInputElement>("input") ?? []),
  ].find((input) => input.value === "Use for strict final reviews.");
  expect(description).toBeDefined();
  expect(description?.maxLength).toBe(MAX_PEER_RUNTIME_DESCRIPTION_CHARS);
  expect(text()).toContain("Shown to agents");
  expect(text()).toContain("without asking you first");
});

test("changing cost saves the user-selected label", () => {
  const onUpdate = render([runtime()]);
  const select = container?.querySelector<HTMLSelectElement>("select");
  if (!select) throw new Error("missing cost select");

  act(() => {
    select.value = "low";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ relativeCost: "low" }),
  ]);
});

test("changing the description saves the agent selection hint", () => {
  const onUpdate = render([runtime()]);
  const input = [
    ...(container?.querySelectorAll<HTMLInputElement>("input") ?? []),
  ].find((candidate) =>
    candidate.placeholder?.startsWith("For example: Fast fixer"),
  );
  if (!input) throw new Error("missing description input");

  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, "Best for small fixes.");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ description: "Best for small fixes." }),
  ]);
});

test("a row that cannot run keeps its place and explains itself", () => {
  render([runtime({ thinkingLevel: "max" })]);

  expect(text()).toContain("Unavailable:");
  expect(text()).toContain("does not support max thinking");
  expect(text()).toContain("never moves to another runtime");
});

test("a row on a disabled account is never told it falls back", () => {
  // The shared slot notice promises that an unusable account degrades to the
  // automatic one. That is true of an ordinary settings slot and false here —
  // the server REFUSES such a row — so this surface must not show it.
  render([runtime()], vi.fn(), {
    models: [],
    profiles: [disabledAccount],
  });

  expect(text()).not.toContain("automatic account");
  expect(text()).not.toMatch(/this runs on/i);
  expect(text()).toContain("Unavailable:");
  expect(text()).toContain("never moves to another runtime");
});

test("a level this build cannot run shows NO selection, not a nearby one", () => {
  // Coercing the stored value for display (to "off", which this model does not
  // support, so the picker clamps it to "Low") would show the user an approval
  // they never made, right beside a warning saying the row cannot run.
  render([runtime({ thinkingLevel: "maximum" })]);

  const thinking = thinkingTrigger();
  expect(thinking?.textContent).toContain("Pick a level");
  expect(thinking?.textContent).not.toMatch(/Low|Medium|High|Off/);
  expect(text()).toContain("not a thinking level this build knows");
});

test("a level the MODEL cannot run also shows no selection", () => {
  // `max` is in the vocabulary but outside Opus's ladder, so the picker used to
  // display its clamped neighbour ("Highest") as the current selection — an
  // approval the human never made, beside a warning that the row cannot run.
  render([runtime({ thinkingLevel: "max" })]);

  const thinking = thinkingTrigger();
  expect(thinking?.textContent).toContain("Pick a level");
  expect(thinking?.textContent).not.toMatch(/Low|Medium|High/);
  expect(text()).toContain("does not support max thinking");
});

test("changing the model never writes a clamped neighbour level", () => {
  // The row is (sonnet, max). Picking Opus, whose ladder stops at xhigh, must
  // not persist xhigh: choosing a model says nothing about the thinking level.
  const onUpdate = render([
    runtime({ modelId: "sonnet", thinkingLevel: "max" }),
  ]);

  const modelTrigger = [...(container?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent?.includes("Select a model"),
  );
  act(() => modelTrigger?.click());
  const option = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Claude Opus"),
  );
  act(() => option?.click());

  const saved = onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes as
    PeerSpawnRuntime[] | undefined;
  expect(saved?.[0]?.modelId).toBe("opus");
  expect(saved?.[0]?.thinkingLevel).toBe("max");
});

test("a supported level still rides along when the model changes", () => {
  // The exact rule must not break the ordinary case: xhigh is on Opus's ladder,
  // so re-picking the model keeps the level the user chose.
  const onUpdate = render([
    runtime({ modelId: "sonnet", thinkingLevel: "xhigh" }),
  ]);

  const modelTrigger = [...(container?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent?.includes("Select a model"),
  );
  act(() => modelTrigger?.click());
  const option = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Claude Opus"),
  );
  act(() => option?.click());

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ modelId: "opus", thinkingLevel: "xhigh" }),
  ]);
});

test("picking a level repairs the row and leaves everything else alone", () => {
  const onUpdate = render([runtime({ thinkingLevel: "maximum" })]);

  act(() => thinkingTrigger()?.click());
  const high = [...(document.querySelectorAll("button") ?? [])].find((node) =>
    node.textContent?.startsWith("High"),
  );
  act(() => high?.click());

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ thinkingLevel: "high" }),
  ]);
});

test("repairing only the model keeps the unrunnable level recorded", () => {
  // Choosing a model says nothing about the thinking level, so the row must
  // keep what it records — and stay unavailable — until the human replaces it.
  const onUpdate = render([
    runtime({ thinkingLevel: "maximum", modelId: "sonnet" }),
  ]);

  const modelTrigger = [...(container?.querySelectorAll("button") ?? [])].find(
    (node) => node.textContent?.includes("Select a model"),
  );
  act(() => modelTrigger?.click());
  const option = [...document.querySelectorAll("button")].find((node) =>
    node.textContent?.includes("Claude Opus"),
  );
  act(() => option?.click());

  const saved = onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes as
    PeerSpawnRuntime[] | undefined;
  expect(saved?.[0]?.modelId).toBe("opus");
  expect(saved?.[0]?.thinkingLevel).toBe("maximum");
});

test("a disabled row is not reported as broken", () => {
  render([runtime({ enabled: false })]);

  expect(text()).not.toContain("Unavailable:");
});

test("adding a runtime saves a new row with a generated id", () => {
  const onUpdate = render([runtime()]);

  const add = [...(container?.querySelectorAll("button") ?? [])].find((node) =>
    node.textContent?.includes("Add runtime"),
  );
  act(() => add?.click());

  const saved = onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes as
    PeerSpawnRuntime[] | undefined;
  expect(saved).toHaveLength(2);
  expect(saved?.[0]?.id).toBe("pr_1");
  expect(saved?.[1]?.id).not.toBe("pr_1");
  expect(saved?.[1]).toMatchObject({
    credentialProfileId: "acct-claude",
    provider: "claude-sdk",
    modelId: "opus",
    relativeCost: "unknown",
    enabled: true,
  });
});

test("removing a runtime saves the rest of the list", () => {
  const onUpdate = render([runtime(), runtime({ id: "pr_2", name: "Other" })]);

  const remove = container?.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove runtime Opus reviewer"]',
  );
  act(() => remove?.click());

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ id: "pr_2", name: "Other" }),
  ]);
});

test("the enable checkbox saves only that row's state", () => {
  const onUpdate = render([runtime()]);

  const checkbox = container?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  act(() => checkbox?.click());

  expect(onUpdate.mock.calls[0]?.[0]?.peerSpawnRuntimes).toEqual([
    runtime({ enabled: false }),
  ]);
});

test("a new row reveals itself instead of landing silently below the fold", () => {
  const scrolls = trackScrolls();
  try {
    const onUpdate = render([runtime()]);
    const add = [...(container?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent?.includes("Add runtime"),
    );
    act(() => add?.click());

    // What the app does with the save: the optimistic patch re-renders the
    // section with the new row.
    const saved = onUpdate.mock.calls[0]?.[0]
      ?.peerSpawnRuntimes as PeerSpawnRuntime[];
    render(saved, onUpdate);
    const added = nameInputs()[1];

    expect(scrolls.targets).toEqual([added]);
    expect(document.activeElement).toBe(added);

    // The server echo replaces the same list again; the row must not move a
    // second time or lose the cursor the user is already typing into.
    render(saved, onUpdate);

    expect(scrolls.targets).toEqual([added]);
    expect(document.activeElement).toBe(added);
  } finally {
    scrolls.restore();
  }
});

test("the reveal survives StrictMode's replayed mount effects", () => {
  const scrolls = trackScrolls();
  try {
    const onUpdate = render([runtime()], vi.fn(), { strict: true });
    const add = [...(container?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent?.includes("Add runtime"),
    );
    act(() => add?.click());
    const saved = onUpdate.mock.calls[0]?.[0]
      ?.peerSpawnRuntimes as PeerSpawnRuntime[];
    render(saved, onUpdate, { strict: true });

    expect(scrolls.targets).toEqual([nameInputs()[1]]);
  } finally {
    scrolls.restore();
  }
});

test("a row that was already there is left where it is", () => {
  const scrolls = trackScrolls();
  try {
    const onUpdate = render([runtime()]);
    render([runtime(), runtime({ id: "pr_2", name: "Other" })], onUpdate);

    expect(scrolls.targets).toEqual([]);
    expect(document.activeElement).not.toBe(nameInputs()[1]);
  } finally {
    scrolls.restore();
  }
});

test("adding is refused, with a reason, while no account offers a model", () => {
  const onUpdate = render([], vi.fn(), { models: [] });
  const add = [...(container?.querySelectorAll("button") ?? [])].find((node) =>
    node.textContent?.includes("Add runtime"),
  );
  act(() => add?.click());

  // A row with no model is dropped by the server normalizer, so the click that
  // would create one is refused where the user can read why.
  expect(add?.hasAttribute("disabled")).toBe(true);
  expect(text()).toContain("No account offers a model right now");
  expect(onUpdate).not.toHaveBeenCalled();
});
