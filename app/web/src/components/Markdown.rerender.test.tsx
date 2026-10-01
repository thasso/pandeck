// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

/**
 * A Markdown re-render must be a RECONCILIATION, not a rebuild.
 *
 * react-markdown renders every node as `createElement(components[tag], …)`, so
 * a `components` map rebuilt per render hands React a new element TYPE for each
 * node — which React handles by unmounting the old subtree and mounting a new
 * one. Nothing looks wrong afterwards, which is what makes this worth pinning:
 * the only visible symptoms are that a wide code block being read loses its
 * horizontal scroll, a selection collapses, and every lazily mounted `CodeBlock`
 * re-runs Shiki, whenever anything upstream re-renders the message.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

const TEXT =
  "Some prose with `inline code`.\n\n- one\n- two\n\n| Column | Value |\n| --- | --- |\n| one | two |\n";

it("keeps its DOM nodes when it re-renders with the same text", async () => {
  let bump = () => {};
  function Host() {
    const [tick, setTick] = useState(0);
    bump = () => setTick((value) => value + 1);
    return (
      <div data-tick={tick}>
        <Markdown
          text={TEXT}
          // A fresh handler identity per render — what every real caller does.
          onOpenSession={() => {}}
          paObjectReferences={[]}
          tableLayout="breakout"
        />
      </div>
    );
  }
  await act(async () => reactRoot.render(<Host />));
  const before = {
    paragraph: container.querySelector("p"),
    code: container.querySelector("code"),
    items: [...container.querySelectorAll("li")],
    tableScroll: container.querySelector(".markdown-table-scroll"),
    table: container.querySelector("table"),
  };
  expect(before.paragraph).toBeTruthy();
  expect(before.code).toBeTruthy();
  expect(before.items).toHaveLength(2);
  expect(
    before.tableScroll?.classList.contains("markdown-table-breakout"),
  ).toBe(true);
  expect(before.table).toBeTruthy();

  await act(async () => bump());
  await act(async () => bump());

  expect(container.querySelector("p")).toBe(before.paragraph);
  expect(container.querySelector("code")).toBe(before.code);
  expect([...container.querySelectorAll("li")]).toEqual(before.items);
  expect(container.querySelector(".markdown-table-scroll")).toBe(
    before.tableScroll,
  );
  expect(container.querySelector("table")).toBe(before.table);
});

it("still re-renders links when the references behind them change", async () => {
  let setTitle = (_: string) => {};
  function Host() {
    const [title, setNext] = useState("First title");
    setTitle = setNext;
    return (
      <Markdown
        text="See [](pa://task/42) for context."
        paObjectReferences={[
          {
            uri: "pa://task/42",
            objectType: "task",
            knownType: true,
            id: "42",
            href: "/tasks/42",
            title,
            typeLabel: "Task",
            existence: "exists",
          },
        ]}
      />
    );
  }
  await act(async () => reactRoot.render(<Host />));
  expect(container.textContent).toContain("First title");

  // The rendered tree is held across renders, so this is the half that would
  // silently stop working if it were held too aggressively.
  await act(async () => setTitle("Second title"));
  expect(container.textContent).toContain("Second title");
});

it("rebuilds the tree when the resolver answers differently for the same text", async () => {
  // A URL is resolved once, WHILE the tree is built, and then frozen into the
  // rendered `src` — so unlike a click handler, a new resolver has to rebuild
  // it. Reusing one Markdown instance across two KB entries (or two file
  // previews) with identical bodies is how that shows: the same relative asset
  // path belongs to a different entry now.
  let setBase = (_: string) => {};
  function Host() {
    const [base, setNext] = useState("/entries/one");
    setBase = setNext;
    const resolve = (url: string) =>
      url.startsWith("assets/") ? `${base}/${url}` : null;
    return <Markdown text="![shot](assets/shot.png)" onResolveUrl={resolve} />;
  }
  await act(async () => reactRoot.render(<Host />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "/entries/one/assets/shot.png",
  );

  await act(async () => setBase("/entries/two"));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "/entries/two/assets/shot.png",
  );
});
