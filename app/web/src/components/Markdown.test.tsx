// @vitest-environment jsdom
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initHistoryNav, resetHistoryNavForTests } from "../lib/historyNav.ts";
import type { LoopbackLink } from "../lib/portForwardLinks.ts";
import { mount, type Mounted } from "../test/mount.tsx";
import { Markdown } from "./Markdown.tsx";

// The loopback-link cases watch the forward; every other export stays real.
const openForwardedLink = vi.hoisted(() =>
  vi.fn<(link: LoopbackLink) => Promise<void>>(),
);
vi.mock("../lib/portForwards.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/portForwards.ts")>()),
  openForwardedLink: (link: LoopbackLink) => openForwardedLink(link),
}));

describe("Markdown source positions", () => {
  it("stamps rendered blocks only when requested", () => {
    const positioned = renderToStaticMarkup(
      <Markdown text={"## Heading\n\nBody"} sourcePositions />,
    );
    expect(positioned).toContain('data-source-line-start="1"');
    expect(positioned).toContain('data-source-line-end="1"');
    expect(positioned).toContain('data-source-line-start="3"');

    const plain = renderToStaticMarkup(<Markdown text="Body" />);
    expect(plain).not.toContain("data-source-line-start");
  });
});

describe("Markdown tables", () => {
  it("keeps wide tables in a keyboard-scrollable region", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "| Capture | Ticket | Scored |\n| --- | --- | --- |\n| one | PA-1 | 2 |"
        }
        sourcePositions
      />,
    );

    expect(html).toContain('class="markdown-table-scroll"');
    expect(html).not.toContain("markdown-table-breakout");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Scrollable table"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(
      '<table data-source-line-start="1" data-source-line-end="3">',
    );
    expect(
      html.match(/<div class="markdown-table-scroll"[^>]*>/)?.[0],
    ).not.toContain("data-source-line");
    expect(html).toContain("<th>Capture</th>");

    const withoutPositions = renderToStaticMarkup(
      <Markdown text={"| Column |\n| --- |\n| Value |"} />,
    );
    expect(withoutPositions).toContain("<table>");
    expect(withoutPositions).not.toContain("data-source-line");
  });

  it("marks tables for breakout only when requested", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={"| Column |\n| --- |\n| Value |"}
        tableLayout="breakout"
      />,
    );

    expect(html).toContain(
      'class="markdown-table-scroll markdown-table-breakout"',
    );
  });
});

describe("Markdown raw HTML", () => {
  it("renders inline ins/del marks (used by the history rendered diff)", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"The <del>old</del><ins>new</ins> value."} />,
    );
    expect(html).toContain("<ins>new</ins>");
    expect(html).toContain("<del>old</del>");
  });

  it("strips dangerous HTML (scripts and event handlers)", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={'Hi <script>alert(1)</script><img src=x onerror="alert(1)">'}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });
});

describe("Markdown pa:// links", () => {
  it("infers titles for empty pa links", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See [](pa://task/257)."
        paObjectReferences={[
          {
            uri: "pa://task/257",
            objectType: "task",
            knownType: true,
            id: "257",
            href: "/tasks/257",
            title:
              "KB 02: Implement generic pa:// object links and title resolution",
            typeLabel: "Task",
            existence: "exists",
          },
        ]}
      />,
    );
    expect(html).toContain(
      "KB 02: Implement generic pa:// object links and title resolution",
    );
    expect(html).toContain('href="/tasks/257"');
  });

  it("autolinks bare pa text", () => {
    const html = renderToStaticMarkup(
      <Markdown text="Open pa://project/time-tracking-automation." />,
    );
    expect(html).toContain('href="/projects/time-tracking-automation"');
    expect(html).toContain("Project time-tracking-automation");
  });

  it("uses id-only references for links with fragments while preserving the target fragment", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See [](pa://knowledge/kb-entry#Heading)."
        paObjectReferences={[
          {
            uri: "pa://knowledge/kb-entry",
            objectType: "knowledge",
            knownType: true,
            id: "kb-entry",
            href: "/knowledge/kb-entry",
            title: "Knowledge entry",
            typeLabel: "Knowledge",
            existence: "exists",
          },
        ]}
      />,
    );
    expect(html).toContain("Knowledge entry");
    expect(html).toContain('href="/knowledge/kb-entry#Heading"');
  });

  it("marks unresolved known objects as broken when supplied by the resolver", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text="See <pa://task/missing>."
        paObjectReferences={[
          {
            uri: "pa://task/missing",
            objectType: "task",
            knownType: true,
            id: "missing",
            href: "/tasks/missing",
            title: "Task missing",
            typeLabel: "Task",
            existence: "missing",
          },
        ]}
      />,
    );
    expect(html).toContain('href="#"');
    expect(html).toContain("text-danger");
  });
});

/**
 * What is NOT math, which is the half of the syntax contract that costs
 * something when it breaks: a single `$` must stay prose. "Markdown math
 * rendering" below covers the rendering of what IS math.
 *
 * These render without effects, so KaTeX never loads here and each formula stays
 * at its placeholder — enough to tell math from prose, which is all these ask.
 */
describe("Markdown math syntax", () => {
  it("leaves single-dollar amounts as prose", () => {
    const html = renderToStaticMarkup(
      <Markdown text="It costs $5, on sale for $3 today." />,
    );
    expect(html).toContain("It costs $5, on sale for $3 today.");
  });

  it("leaves math delimiters inside code as code", () => {
    const fenced = renderToStaticMarkup(
      <Markdown text={"```\n$$x^2$$\n```"} />,
    );
    expect(fenced).toContain("$$x^2$$");

    const inline = renderToStaticMarkup(
      <Markdown text="a `$$x^2$$` literal" />,
    );
    expect(inline).toContain("<code>$$x^2$$</code>");
  });
});

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
describe("Markdown re-renders", () => {
  let container: HTMLDivElement;
  let reactRoot: Root;

  beforeEach(() => {
    ({ container, root: reactRoot } = mount());
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
      return (
        <Markdown text="![shot](assets/shot.png)" onResolveUrl={resolve} />
      );
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
});

/**
 * `[![alt](image)](target)` — an author asking for a picture that links
 * somewhere. Both halves have to survive: the picture renders, and the LINK the
 * author wrote is where a click goes. The one thing it may never become is
 * nested interaction — an anchor inside an anchor, or the standalone embed's
 * Play/Open control inside a link — which is invalid DOM and unusable with a
 * keyboard. Origin rules are unchanged: a foreign image or destination is left
 * exactly as authored and mints nothing.
 */
describe("Markdown linked images", () => {
  let view: Mounted;

  beforeEach(() => {
    (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__ = "tok-1";
    resetHistoryNavForTests();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/sessions/s1");
    initHistoryNav();
    view = mount();
  });

  afterEach(() => {
    delete (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__;
    vi.unstubAllGlobals();
  });

  function render(text: string): void {
    view.render(<Markdown text={text} />);
  }

  function anchors(): HTMLAnchorElement[] {
    return [...view.container.querySelectorAll("a")];
  }

  function click(node: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  }

  const PLOT = "/api/files/tmp/example/plot.png";

  it("keeps the authored internal link around a local image", () => {
    render(`[![the plot](${PLOT})](/api/files/tmp/example/report.md)`);

    expect(anchors()).toHaveLength(1);
    const link = anchors()[0]!;
    expect(link.getAttribute("href")).toBe("/files/tmp/example/report.md");
    const image = link.querySelector("img")!;
    const src = new URL(image.getAttribute("src")!);
    expect(src.pathname).toBe(PLOT);
    expect(src.searchParams.get("token")).toBe("tok-1");
    expect(image.getAttribute("alt")).toBe("the plot");
    // One anchor, no control inside it, and no card chrome.
    expect(link.querySelector("a")).toBeNull();
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).not.toContain("Preview only");
    expect(view.container.textContent).not.toContain("Open in viewer");

    // A plain click opens the document in-app; a modifier click is the browser's.
    expect(click(image).defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe("/files/tmp/example/report.md");
    expect(click(image, { metaKey: true }).defaultPrevented).toBe(false);
  });

  it("keeps a foreign destination external and a foreign image as authored", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(
      "[![a diagram](https://example.com/diagram.png)](https://example.com/post)",
    );

    const link = anchors()[0]!;
    expect(anchors()).toHaveLength(1);
    expect(link.getAttribute("href")).toBe("https://example.com/post");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    const image = link.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("https://example.com/diagram.png");
    expect(image.getAttribute("src")).not.toContain("token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mixes sources without letting either half change the other", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // A foreign picture linking into the app, and a local picture linking out.
    render(
      [
        "[![remote](https://example.com/shot.png)](/api/files/tmp/example/report.md)",
        `[![local](${PLOT})](https://example.com/post)`,
      ].join("\n\n"),
    );

    const [internal, external] = anchors();
    expect(internal!.getAttribute("href")).toBe("/files/tmp/example/report.md");
    expect(internal!.getAttribute("target")).toBeNull();
    expect(internal!.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/shot.png",
    );
    expect(external!.getAttribute("href")).toBe("https://example.com/post");
    expect(external!.getAttribute("target")).toBe("_blank");
    expect(
      new URL(external!.querySelector("img")!.getAttribute("src")!).pathname,
    ).toBe(PLOT);
    // A lookalike foreign path is never treated as a local file.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never treats a foreign lookalike destination as an internal document", () => {
    const foreign = "https://evil.example/api/files/tmp/example/report.md";
    render(`[![the plot](${PLOT})](${foreign})`);
    const link = anchors()[0]!;
    expect(link.getAttribute("href")).toBe(foreign);
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("names a link whose picture carries no alt text", () => {
    render(`[![](${PLOT})](/api/files/tmp/example/report.md)`);
    expect(anchors()[0]?.getAttribute("aria-label")).toBe("Open report.md");

    act(() => view.root.unmount());
    view = mount();
    // Alt text is the accessible name when the author wrote one.
    render(`[![the plot](${PLOT})](/api/files/tmp/example/report.md)`);
    expect(anchors()[0]?.getAttribute("aria-label")).toBeNull();
    expect(anchors()[0]?.querySelector("img")?.getAttribute("alt")).toBe(
      "the plot",
    );
  });

  it("degrades a linked non-image embed to the link's own text", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(
      [
        "[![recording](/api/files/tmp/example/clip.mp3)](https://example.com/post)",
        "[![preview](/api/files/tmp/example/page.html)](/api/files/tmp/example/report.md)",
      ].join("\n\n"),
    );

    // No Play button, no sandboxed frame, and no grant minted inside a link.
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.querySelector("iframe")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    const [media, html] = anchors();
    expect(media!.getAttribute("href")).toBe("https://example.com/post");
    expect(media!.textContent).toBe("recording");
    expect(html!.getAttribute("href")).toBe("/files/tmp/example/report.md");
    expect(html!.textContent).toBe("preview");
    for (const link of anchors()) expect(link.querySelector("a")).toBeNull();
  });

  it("leaves a standalone image embed bare, with no link wrapped around it", () => {
    render(`![the plot](${PLOT})`);
    expect(anchors()).toHaveLength(0);
    expect(view.container.querySelector("img")?.getAttribute("loading")).toBe(
      "lazy",
    );
  });
});

/**
 * Phase 3 of `docs/port-forwarding.md`: a plain click on a `localhost:PORT`
 * link in a conversation, read in the macOS app served from the tailnet, is
 * forwarded rather than opened as written. The interception has to be exactly
 * that narrow — every other click, client and link keeps the anchor's own
 * behaviour, and the anchor itself is unchanged so a modified click, the
 * context menu and a drag still see the authored URL.
 */
describe("Markdown loopback links", () => {
  let view: Mounted;

  beforeEach(() => {
    openForwardedLink.mockReset();
    openForwardedLink.mockResolvedValue(undefined);
    document.documentElement.setAttribute("data-native-shell", "macos");
    vi.stubEnv("VITE_SERVER_ORIGIN", "app.acme.test");
    view = mount();
  });

  afterEach(() => {
    document.documentElement.removeAttribute("data-native-shell");
    vi.unstubAllEnvs();
  });

  function render(text: string): HTMLAnchorElement {
    view.render(<Markdown text={text} />);
    return view.container.querySelector("a")!;
  }

  function click(node: Element, init: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...init,
    });
    act(() => {
      node.dispatchEvent(event);
    });
    return event;
  }

  const LINK = "[dev server](http://127.0.0.1:5173/app?tab=1#top)";

  it("forwards a plain click and keeps the authored anchor", () => {
    const anchor = render(LINK);
    expect(anchor.getAttribute("href")).toBe(
      "http://127.0.0.1:5173/app?tab=1#top",
    );
    expect(anchor.getAttribute("target")).toBe("_blank");

    const event = click(anchor);
    expect(event.defaultPrevented).toBe(true);
    expect(openForwardedLink).toHaveBeenCalledWith({
      port: 5173,
      localUrl: "http://localhost:5173/app?tab=1#top",
    });
  });

  it("leaves a modified click to the browser", () => {
    const anchor = render(LINK);
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = click(anchor, init);
      expect(event.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
    expect(openForwardedLink).not.toHaveBeenCalled();
  });

  it("does nothing outside the macOS shell", () => {
    document.documentElement.removeAttribute("data-native-shell");
    expect(click(render(LINK)).defaultPrevented).toBe(false);
    document.documentElement.setAttribute("data-native-shell", "ios");
    expect(click(render(LINK)).defaultPrevented).toBe(false);
    expect(openForwardedLink).not.toHaveBeenCalled();
  });

  it("does nothing when the app itself is served from loopback", () => {
    vi.stubEnv("VITE_SERVER_ORIGIN", "localhost:8787");
    expect(click(render(LINK)).defaultPrevented).toBe(false);
    expect(openForwardedLink).not.toHaveBeenCalled();
  });

  it("does nothing for links that are not explicit loopback URLs with a port", () => {
    for (const href of [
      "https://app.acme.test/sessions",
      "http://localhost/",
      "http://localhost:80/",
      "http://localhost:1023/",
      "http://localhost.example:5173/",
    ]) {
      const event = click(render(`[x](${href})`));
      expect(event.defaultPrevented, href).toBe(false);
    }
    expect(openForwardedLink).not.toHaveBeenCalled();
  });
});

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
describe("Markdown math rendering", { timeout: 30_000 }, () => {
  // The first case pays for the COLD import: `vi.resetModules()` re-evaluates
  // the whole Markdown chain and the 266 KB KaTeX chunk on top. Under a second
  // on an idle machine, but a CI runner that is also running the server suite,
  // linting and building has pushed it past the 5 s default — and a case
  // abandoned by its timeout keeps polling inside `act`, so every later case in
  // the file fails on "overlapping act() calls". Nothing asserted here depends
  // on time; the budget only has to be generous enough that a slow run is still
  // a run.
  let container: HTMLDivElement;
  let reactRoot: Root;

  // `vi.resetModules()` keeps the mock registry, so a case's `vi.doMock` of
  // `rehype-katex` would reach every later case: each one starts unmocked.
  beforeEach(() => {
    vi.doUnmock("rehype-katex");
    vi.resetModules();
    ({ container, root: reactRoot } = mount());
  });

  afterEach(() => {
    vi.doUnmock("rehype-katex");
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
