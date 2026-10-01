// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LaTeX math in chat, end to end through the real lazy load.
 *
 * KaTeX is 266 KB and most messages have no math, so it is fetched on first
 * sight of a formula. That makes the rendered result ASYNCHRONOUS, and these
 * cases exercise both sides of the switch: the placeholder before the chunk
 * lands and the MathML after. Rendering to static markup cannot see the second
 * half at all — no effects run there — which is why this file drives a real
 * root.
 *
 * Each case re-imports `Markdown.tsx` through `vi.resetModules()`: the loaded
 * plugin array is module state, deliberately shared by every message in the app,
 * so without a reset the first case would leave KaTeX loaded for the rest and
 * the placeholder assertions would silently stop testing anything.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The first case pays for the COLD import: `vi.resetModules()` re-evaluates
// the whole Markdown chain and the 266 KB KaTeX chunk on top. Under a second
// on an idle machine, but a CI runner that is also running the server suite,
// linting and building has pushed it past the 5 s default — and a case
// abandoned by its timeout keeps polling inside `act`, so every later case in
// the file fails on "overlapping act() calls". Nothing asserted here depends
// on time; the budget only has to be generous enough that a slow run is still
// a run.
vi.setConfig({ testTimeout: 30_000 });

let container: HTMLDivElement;
let reactRoot: Root;

beforeEach(() => {
  vi.resetModules();
  container = document.createElement("div");
  document.body.append(container);
  reactRoot = createRoot(container);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  container.remove();
});

async function loadMarkdown() {
  return (await import("./Markdown.tsx")).Markdown;
}

/** One macrotask inside `act`, so a resolved import can commit its re-render. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Render, then wait for KaTeX to land.
 *
 * Polls rather than flushing a fixed number of times: the first of these imports
 * in a worker has 266 KB to transform and takes many macrotasks, while a later
 * one is already cached and takes one. A fixed flush count therefore passes or
 * fails according to whether some other test file happened to run first.
 */
async function renderMath(text: string): Promise<HTMLElement> {
  const Markdown = await loadMarkdown();
  await act(async () => reactRoot.render(<Markdown text={text} />));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (container.querySelector("math, .katex-error")) break;
    await flush();
  }
  return container;
}

describe("Markdown math rendering", () => {
  it("renders $$…$$ inside a sentence as inline MathML", async () => {
    const dom = await renderMath("The weight $$W = H/2$$ is fine.");

    const math = dom.querySelector("math");
    expect(math).not.toBeNull();
    expect(math?.getAttribute("display")).toBeNull();
    // The formula sits in the sentence, not in a block of its own.
    expect(dom.querySelector("p")?.textContent).toContain("The weight");
    expect(dom.querySelector("p")?.contains(math!)).toBe(true);
  });

  it("renders $$…$$ alone in a paragraph as display MathML", async () => {
    const dom = await renderMath("Before\n\n$$\nH = I - G(I)\n$$\n\nAfter");

    const math = dom.querySelector("math");
    expect(math).not.toBeNull();
    expect(math?.getAttribute("display")).toBe("block");
  });

  it("renders operators and fractions rather than dropping them", async () => {
    const dom = await renderMath(
      "$$W = \\frac{H}{\\sqrt{\\operatorname{BoxMean}(H^2)} + 1}$$",
    );

    // KaTeX emits MathML elements for the structure: a fraction and a root.
    expect(dom.querySelector("mfrac")).not.toBeNull();
    expect(dom.querySelector("msqrt")).not.toBeNull();
    expect(dom.textContent).toContain("BoxMean");
  });

  it("shows the LaTeX source, not a code block, until KaTeX lands", async () => {
    const Markdown = await loadMarkdown();
    // The SYNCHRONOUS `act`: it flushes the effect that starts the import but
    // not the microtask that resolves it, which is exactly the first paint a
    // reader sees. The async form would settle the import and skip past it.
    act(() => reactRoot.render(<Markdown text="$$x^2$$" />));

    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toBe("x^2");
  });

  it("renders a ```math fence as display MathML", async () => {
    // A third route to the same `language-math` class, alongside `$$…$$` and
    // raw HTML: `remark-math` is not involved in a fence at all. One reason the
    // detector reads the sanitized HAST rather than the Markdown tree.
    const dom = await renderMath("```math\nH = I - G(I)\n```");

    expect(dom.querySelector("math")?.getAttribute("display")).toBe("block");
    expect(dom.querySelector("pre")).toBeNull();
  });

  it("renders a malformed formula without throwing", async () => {
    const dom = await renderMath("$$\\frac{1}{$$");

    expect(dom.querySelector(".katex-error")).not.toBeNull();
  });

  it("clamps a formula that asks for an enormous size", async () => {
    // Untrusted text: without KaTeX's `maxSize` (its default is `Infinity`)
    // one message renders a box that swallows the whole transcript.
    const dom = await renderMath("$$\\rule{999999em}{999999em}$$");

    const sized = [...dom.querySelectorAll("[width], [height]")];
    expect(sized.length).toBeGreaterThan(0);
    // Attributes only: the MathML `<annotation>` keeps the original TeX source,
    // so the number itself is legitimately still in the tree as text.
    const sizes = sized.flatMap((element) => [
      element.getAttribute("width"),
      element.getAttribute("height"),
    ]);
    for (const size of sizes) {
      if (size !== null) expect(size).not.toContain("999999");
    }
  });

  it("renders raw-HTML math deterministically, not once KaTeX happens to be up", async () => {
    // `<code class="language-math">` passes the sanitize schema and KaTeX
    // renders it, but in remark raw HTML is one opaque string. Detection has to
    // run in rehype, after the parse, or this input renders as source or as math
    // depending on what an unrelated earlier message already loaded.
    const dom = await renderMath('<code class="language-math">x^2</code>');

    expect(dom.querySelector("math")).not.toBeNull();
  });

  it("sees a math class written as a character reference", async () => {
    // The case a substring match on the raw HTML misses: `rehype-raw` decodes
    // this to a real `language-math` class that KaTeX then renders, so anything
    // reading the undecoded source disagrees with what actually gets rendered.
    const dom = await renderMath('<code class="language&#x2d;math">y^2</code>');

    expect(dom.querySelector("math")).not.toBeNull();
  });

  it("catches up a formula that was on screen when an import failed", async () => {
    let attempts = 0;
    vi.doMock("rehype-katex", async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("chunk load failed");
      return await vi.importActual("rehype-katex");
    });
    const Markdown = await loadMarkdown();

    // First formula: its import rejects, so it stays at its placeholder.
    await act(async () =>
      reactRoot.render(
        <div>
          <Markdown text="$$x^2$$" />
        </div>,
      ),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) await flush();
    expect(container.querySelector("math")).toBeNull();

    // A second formula mounts and retries. `Markdown` is memoized and the first
    // one's props are unchanged, so it does NOT re-render and cannot re-subscribe
    // by itself — if the failed attempt dropped its waiter, it stays raw source
    // forever while its neighbour renders fine.
    await act(async () =>
      reactRoot.render(
        <div>
          <Markdown text="$$x^2$$" />
          <Markdown text="$$y^2$$" />
        </div>,
      ),
    );
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (container.querySelectorAll("math").length >= 2) break;
      await flush();
    }

    expect(attempts).toBe(2);
    expect(container.querySelectorAll("math")).toHaveLength(2);
  });

  it("does not fetch KaTeX for a message with no math", async () => {
    // Counts the IMPORT, not the output: asserting only that no `<math>`
    // appeared would still pass if the 266 KB chunk were pulled in for every
    // message that merely mentions a price, which is the whole point of the
    // static detector.
    let imports = 0;
    vi.doMock("rehype-katex", () => {
      imports += 1;
      return { default: () => () => {} };
    });
    const Markdown = await loadMarkdown();

    await act(async () =>
      reactRoot.render(<Markdown text="It costs $5, on sale for $3." />),
    );
    // Generous on purpose: this asserts an ABSENCE, so it has to outlast the
    // window in which a load kicked off by this render could still commit.
    for (let attempt = 0; attempt < 10; attempt += 1) await flush();

    expect(imports).toBe(0);
    expect(container.querySelector("math")).toBeNull();
    expect(container.textContent).toContain("It costs $5, on sale for $3.");

    // The counter is wired up: the same module DOES import for real math.
    await act(async () => reactRoot.render(<Markdown text="$$x^2$$" />));
    for (let attempt = 0; attempt < 10; attempt += 1) await flush();
    expect(imports).toBe(1);
  });
});
