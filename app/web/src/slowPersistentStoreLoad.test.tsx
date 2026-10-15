// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestionRequest } from "@assistant/shared";
import { AgentQuestionForm } from "./components/AgentQuestionForm.tsx";
import { useBrowserDraft } from "./hooks/useBrowserDraft.ts";
import { usePrefs, type Prefs } from "./hooks/usePrefs.ts";
import type { ListableStorage } from "./lib/localStore.ts";
import {
  createPersistentStore,
  supersedes,
  type PersistentStore,
  type PersistentStoreBackend,
  type StoredEntry,
} from "./lib/persistentStore.ts";
import {
  recentTranscripts,
  recordTranscript,
} from "./lib/recentTranscripts.ts";

/**
 * The app renders once `loadPersistentStore` gives up waiting (300 ms), so a
 * slow IndexedDB read answers AFTER the first render. These run the real
 * consumers against the real store in that order and check that rendering
 * never replaces what the database holds, and that it shows up once read.
 */

const current = vi.hoisted(() => ({ store: null as PersistentStore | null }));
vi.mock("./lib/persistentStore.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/persistentStore.ts")>()),
  persistentStore: () => current.store!,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(entries: Record<string, string> = {}): ListableStorage {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    keys: () => [...map.keys()],
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A store whose database read answers only on `release()`. The database keeps
 * stamps as IndexedDB does; `storedAt` puts them ahead of this window's clock
 * (`now`), as another window's clock or an earlier one can.
 */
async function slowBoot(
  entries: Record<string, string>,
  options: {
    legacy?: Record<string, string>;
    failLoad?: boolean;
    storedAt?: number;
    now?: () => number;
  } = {},
) {
  const stored = new Map<string, StoredEntry>(
    Object.entries(entries).map(([key, value]) => [
      key,
      { value, at: options.storedAt ?? 1, by: "seed" },
    ]),
  );
  const legacy = memoryStorage(options.legacy);
  let release = () => {};
  let gate = new Promise<void>((resolve) => (release = resolve));
  const timers: { run: () => void; ms: number }[] = [];
  const backend: PersistentStoreBackend = {
    async load() {
      await gate;
      if (options.failLoad) throw new Error("no database");
      return new Map(stored);
    },
    async commit(batch) {
      for (const [key, entry] of batch) {
        const held = stored.get(key);
        if (!held || supersedes(entry, held)) stored.set(key, entry);
      }
    },
  };
  const store = createPersistentStore({
    backend,
    legacy,
    schedule: (run, ms) => void timers.push({ run, ms }),
    ...(options.now ? { now: options.now } : {}),
  });
  current.store = store;
  const loading = store.load(300);
  for (const timer of timers.splice(0)) if (timer.ms === 300) timer.run();
  await loading;
  expect(store.isLoaded()).toBe(false);
  return {
    db: { get: (key: string) => stored.get(key)?.value ?? undefined },
    legacy,
    store,
    /** What the next page load reads for `key`. */
    async reopen(key: string) {
      gate = Promise.resolve();
      const next = createPersistentStore({ backend, legacy: memoryStorage() });
      await next.load(300);
      return next.getItem(key);
    },
    async release() {
      release();
      await act(settle);
    },
    async flush() {
      store.flush();
      await settle();
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactNode): HTMLDivElement {
  container ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(container);
  act(() => root!.render(element));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  current.store = null;
  localStorage.clear();
});

const DRAFT_KEY = "assistant.composerDraft.session:s1";

let setDraft: (value: string) => void = () => {};
function DraftProbe({ storageKey }: { storageKey: string }) {
  const [draft, set] = useBrowserDraft(storageKey);
  setDraft = set;
  return <output>{draft}</output>;
}

let updatePrefs: (patch: Partial<Prefs>) => void = () => {};
function PrefsProbe() {
  const { prefs, update } = usePrefs();
  updatePrefs = update;
  return <output>{JSON.stringify(prefs)}</output>;
}

const shownPrefs = (el: HTMLElement) =>
  JSON.parse(el.querySelector("output")!.textContent!) as Prefs;

describe("rendering before a slow persistent-store load", () => {
  it("keeps a saved draft and shows it once the read lands", async () => {
    const boot = await slowBoot({ [DRAFT_KEY]: "unsent user text" });
    const el = render(<DraftProbe storageKey={DRAFT_KEY} />);
    expect(el.textContent).toBe("");
    await boot.flush();
    expect(boot.db.get(DRAFT_KEY)).toBe("unsent user text");

    await boot.release();
    expect(el.textContent).toBe("unsent user text");
    await boot.flush();
    expect(boot.db.get(DRAFT_KEY)).toBe("unsent user text");
  });

  // Ahead: the stored draft's stamp is past this window's clock.
  for (const ahead of [false, true])
    it(`keeps what the user typed before the read landed${ahead ? " (stored clock ahead)" : ""}`, async () => {
      const boot = await slowBoot(
        { [DRAFT_KEY]: "older draft" },
        ahead ? { storedAt: 5_000, now: () => 1_000 } : {},
      );
      const el = render(<DraftProbe storageKey={DRAFT_KEY} />);
      act(() => setDraft("typed during boot"));

      await boot.release();
      expect(el.textContent).toBe("typed during boot");
      await boot.flush();
      expect(boot.db.get(DRAFT_KEY)).toBe("typed during boot");
      expect(await boot.reopen(DRAFT_KEY)).toBe("typed during boot");
    });

  it("keeps a draft the user cleared before the read landed (stored clock ahead)", async () => {
    const boot = await slowBoot(
      { [DRAFT_KEY]: "older draft" },
      { storedAt: 5_000, now: () => 1_000 },
    );
    const el = render(<DraftProbe storageKey={DRAFT_KEY} />);
    act(() => setDraft("typed"));
    act(() => setDraft(""));

    await boot.release();
    expect(el.textContent).toBe("");
    await boot.flush();
    expect(boot.db.get(DRAFT_KEY)).toBeUndefined();
    expect(await boot.reopen(DRAFT_KEY)).toBeNull();
  });

  it("keeps saved preferences and replays changes made before the read", async () => {
    const stored = JSON.stringify({ theme: "light", sidebarWidth: 300 });
    const boot = await slowBoot({ "assistant.prefs": stored });
    const el = render(<PrefsProbe />);
    expect(shownPrefs(el).theme).toBe("dark");
    act(() => updatePrefs({ showTools: true }));
    await boot.flush();
    expect(boot.db.get("assistant.prefs")).toBe(stored);
    // Nor the pre-paint slice: the next boot would paint the defaults.
    expect(localStorage.getItem("assistant.prefs.paint")).toBeNull();

    await boot.release();
    expect(shownPrefs(el)).toMatchObject({
      theme: "light",
      sidebarWidth: 300,
      showTools: true,
    });
    await boot.flush();
    expect(JSON.parse(boot.db.get("assistant.prefs")!) as Prefs).toMatchObject({
      theme: "light",
      sidebarWidth: 300,
      showTools: true,
    });
    expect(localStorage.getItem("assistant.prefs.paint")).toBe(
      JSON.stringify({ theme: "light", textScale: 100 }),
    );
  });

  it("keeps drafts and preferences migrated from localStorage on that read", async () => {
    const prefs = JSON.stringify({ theme: "light" });
    const boot = await slowBoot(
      {},
      { legacy: { [DRAFT_KEY]: "legacy draft", "assistant.prefs": prefs } },
    );
    const draft = render(
      <>
        <DraftProbe storageKey={DRAFT_KEY} />
        <PrefsProbe />
      </>,
    );
    await boot.release();
    const [draftOut] = draft.querySelectorAll("output");
    expect(draftOut!.textContent).toBe("legacy draft");
    expect(boot.db.get(DRAFT_KEY)).toBe("legacy draft");
    expect(boot.db.get("assistant.prefs")).toBe(prefs);
    expect(boot.legacy.keys()).toEqual([]);
  });

  it("keeps localStorage's copy when the read fails over to it", async () => {
    const boot = await slowBoot(
      {},
      { legacy: { [DRAFT_KEY]: "legacy draft" }, failLoad: true },
    );
    const el = render(<DraftProbe storageKey={DRAFT_KEY} />);
    await boot.release();
    expect(el.textContent).toBe("legacy draft");
    expect(boot.legacy.getItem(DRAFT_KEY)).toBe("legacy draft");
  });

  it("keeps the answers to a pending agent question", async () => {
    const request: AgentQuestionRequest = {
      requestId: "q1",
      toolCallId: "t1",
      sessionId: "s1",
      title: "Check",
      questions: [
        {
          id: "label",
          title: "Label",
          style: "text",
          required: true,
          allowTypedAnswer: true,
          defaultChoiceIds: [],
        },
      ],
      createdAt: 1,
    };
    const answerKey = "assistant.agentQuestionDraft.s1.q1";
    const stored = JSON.stringify({
      version: 1,
      requestId: "q1",
      index: 0,
      drafts: { label: { choiceIds: [], text: "my answer" } },
      updatedAt: 1,
    });
    const boot = await slowBoot({ [answerKey]: stored });
    const el = render(
      <AgentQuestionForm request={request} onRespond={() => {}} />,
    );
    const field = () => el.querySelector<HTMLInputElement>("input")!;
    expect(field().value).toBe("");
    await boot.flush();
    expect(boot.db.get(answerKey)).toBe(stored);

    await boot.release();
    expect(field().value).toBe("my answer");
  });

  it("merges stored answers into a question form edited before the read", async () => {
    const textQuestion = (id: string) => ({
      id,
      title: id,
      style: "text" as const,
      required: true,
      allowTypedAnswer: true,
      defaultChoiceIds: [],
    });
    const request: AgentQuestionRequest = {
      requestId: "q2",
      toolCallId: "t2",
      sessionId: "s1",
      title: "Check",
      questions: [textQuestion("first"), textQuestion("second")],
      createdAt: 1,
    };
    const answerKey = "assistant.agentQuestionDraft.s1.q2";
    const boot = await slowBoot({
      [answerKey]: JSON.stringify({
        version: 1,
        requestId: "q2",
        index: 1,
        drafts: {
          first: { choiceIds: [], text: "saved first" },
          second: { choiceIds: [], text: "saved second" },
        },
        updatedAt: 1,
      }),
    });
    const el = render(
      <AgentQuestionForm request={request} onRespond={() => {}} />,
    );
    const field = () => el.querySelector<HTMLInputElement>("input")!;
    act(() => {
      const input = field();
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "typed first");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await boot.release();
    // Still on the step being typed into, with what was typed.
    expect(field().value).toBe("typed first");
    const next = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    )!;
    act(() => next.click());
    expect(field().value).toBe("saved second");
    await boot.flush();
    expect(JSON.parse(boot.db.get(answerKey)!)).toMatchObject({
      drafts: {
        first: { text: "typed first" },
        second: { text: "saved second" },
      },
    });
  });

  it("keeps the recent dictation list when a transcript lands first", async () => {
    const at = 1_000;
    const stored = JSON.stringify([{ text: "said earlier", at }]);
    const boot = await slowBoot({ "assistant.dictation.recent": stored });
    recordTranscript("said during boot", at + 1);
    await boot.flush();
    expect(boot.db.get("assistant.dictation.recent")).toBe(stored);

    await boot.release();
    expect(recentTranscripts().map((entry) => entry.text)).toEqual([
      "said during boot",
      "said earlier",
    ]);
  });
});
