// @vitest-environment jsdom
/**
 * Open Initiative browser rows against the shared graph cache
 * (`app/web/docs/ui-shell.md`, Initiative browser): the cache keeps six idle
 * reads, so an open row PINS its read while it draws it. Seven open rows
 * therefore read once each and settle, instead of evicting and re-reading
 * each other forever; closing or unmounting a row releases its pin and the
 * idle bound applies again, without a re-read.
 *   pnpm --filter @assistant/web test src/initiativeBrowserCacheScenario.test.tsx
 */
import { act, useCallback, useReducer, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInitialState,
  reduceAssistantState,
  type UIState,
} from "./hooks/useAssistant.ts";
import { InitiativeBrowserGroup } from "./components/initiative/InitiativeBrowserGroup.tsx";
import { mount } from "./test/mount.tsx";
import {
  HOSTED_LABS_DETAIL,
  HOSTED_LABS_LAYOUT,
  hostedLabsSummary,
} from "../component-preview/fixtures/initiatives.ts";

const IDS = ["1", "2", "3", "4", "5", "6", "7"];
const SUMMARIES = IDS.map((id) =>
  hostedLabsSummary({ id, title: `Initiative ${id}`, state: "active" }),
);

interface Harness {
  state: () => UIState;
  /** Every read the rows asked the server for, in order. */
  requests: string[];
  /** Answer every read in flight, as the server would. */
  answer: () => void;
  setShown: (shown: boolean) => void;
}

function harness(): Harness {
  const requests: string[] = [];
  const inFlight = new Set<string>();
  let current: UIState | undefined;
  let dispatchRef:
    ((action: Parameters<typeof reduceAssistantState>[1]) => void) | undefined;
  let showRef: ((shown: boolean) => void) | undefined;

  function Host() {
    const [state, dispatch] = useReducer(
      reduceAssistantState,
      undefined,
      createInitialState,
    );
    const [shown, setShown] = useState(true);
    current = state;
    dispatchRef = dispatch;
    showRef = setShown;
    // `requestInitiativeDetail`: one read per Initiative in flight.
    const onLoadDetail = useCallback((id: string) => {
      if (inFlight.has(id)) return;
      inFlight.add(id);
      requests.push(id);
      dispatch({ kind: "initiativeDetailLoad", id });
    }, []);
    // `retainInitiativeDetail`.
    const onRetainDetail = useCallback((id: string) => {
      dispatch({ kind: "initiativeDetailPin", id, delta: 1 });
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        dispatch({ kind: "initiativeDetailPin", id, delta: -1 });
      };
    }, []);
    const navigate = useRef(() => {}).current;
    return shown ? (
      <InitiativeBrowserGroup
        initiatives={SUMMARIES}
        fresh
        refreshing={false}
        error={null}
        onRetry={() => {}}
        selectedId={null}
        onNavigate={navigate}
        initiativeDetails={state.initiativeDetails}
        onLoadDetail={onLoadDetail}
        onRetainDetail={onRetainDetail}
      />
    ) : null;
  }

  mount(<Host />);
  return {
    state: () => current!,
    requests,
    answer: () => {
      const pending = [...inFlight];
      inFlight.clear();
      act(() => {
        for (const id of pending)
          dispatchRef!({
            kind: "initiativeDetailResult",
            id,
            read: {
              item: { ...HOSTED_LABS_DETAIL, id },
              layout: HOSTED_LABS_LAYOUT,
            },
            revision: 1,
          });
      });
    },
    setShown: (shown) => act(() => showRef!(shown)),
  };
}

/** Answer until no read is in flight, at most `rounds` times. */
function settle(view: Harness, rounds = 12): number {
  let round = 0;
  for (; round < rounds; round += 1) {
    const before = view.requests.length;
    view.answer();
    if (view.requests.length === before) break;
  }
  return round;
}

function toggle(id: string) {
  const button = document.querySelector<HTMLButtonElement>(
    `button[aria-label$="contents of Initiative ${id}"]`,
  );
  expect(button, `the disclosure of Initiative ${id}`).not.toBeNull();
  act(() => button!.click());
}

const held = (state: UIState) => Object.keys(state.initiativeDetails).sort();

describe("open Initiative rows and the shared graph cache", () => {
  afterEach(() => window.sessionStorage.clear());

  it("reads seven open rows once each, and releases them into the idle bound", () => {
    for (const id of IDS)
      window.sessionStorage.setItem(
        `assistant.initiativeBrowser.expanded.v1:${id}`,
        "true",
      );
    const view = harness();
    expect(view.requests.sort()).toEqual(IDS);
    expect(settle(view), "the answers settle without new reads").toBeLessThan(
      2,
    );
    expect(view.requests, "one read per open row").toHaveLength(7);
    expect(held(view.state())).toEqual(IDS);
    for (const id of IDS) expect(view.state().initiativeDetailPins[id]).toBe(1);

    // Closing every row leaves seven idle reads: the oldest one goes, and the
    // closed rows keep their counts without reading again.
    for (const id of IDS) toggle(id);
    expect(view.state().initiativeDetailPins).toEqual({});
    expect(held(view.state())).toHaveLength(6);
    settle(view);
    expect(view.requests, "no re-read after release").toHaveLength(7);
  });

  it("releases every pin when the rows unmount", () => {
    for (const id of IDS)
      window.sessionStorage.setItem(
        `assistant.initiativeBrowser.expanded.v1:${id}`,
        "true",
      );
    const view = harness();
    settle(view);
    view.setShown(false);
    expect(view.state().initiativeDetailPins).toEqual({});
    expect(held(view.state())).toHaveLength(6);
  });
});

describe("the Initiative detail pins", () => {
  const answer = (state: UIState, id: string) =>
    reduceAssistantState(state, {
      kind: "initiativeDetailResult",
      id,
      read: null,
      revision: 1,
    });
  const pin = (state: UIState, id: string, delta: 1 | -1) =>
    reduceAssistantState(state, { kind: "initiativeDetailPin", id, delta });

  it("keeps pinned reads beside six idle ones and the open map's", () => {
    let state = reduceAssistantState(createInitialState(), {
      kind: "setOpenInitiative",
      id: "open",
    });
    for (const id of ["p1", "p2", "p3"]) state = pin(state, id, 1);
    for (const id of [
      "open",
      "p1",
      "p2",
      "p3",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
    ])
      state = answer(state, id);
    // Three pinned, the open one, and the six newest idle reads.
    expect(held(state)).toEqual(
      ["c", "d", "e", "f", "g", "h", "open", "p1", "p2", "p3"].sort(),
    );
    expect(Object.keys(state.initiativeDetailRevisions).sort()).toEqual(
      held(state),
    );

    // Counted: a second holder keeps it through the first release.
    state = pin(state, "p1", 1);
    state = pin(state, "p1", -1);
    expect(held(state)).toContain("p1");
    // The last release puts it back in the idle LRU, inside its bound.
    state = pin(state, "p1", -1);
    expect(state.initiativeDetailPins).toEqual({ p2: 1, p3: 1 });
    expect(held(state)).toHaveLength(9);
    expect(held(state)).toContain("open");
  });
});
