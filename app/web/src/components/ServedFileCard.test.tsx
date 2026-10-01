// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DisplayBlock } from "@assistant/shared";
import { Markdown } from "./Markdown.tsx";
import { ServedFileCard } from "./ServedFileCard.tsx";
import { renderToolBlock } from "./tools/registry.tsx";

/**
 * An agent shows a host file by writing a Markdown link or image at
 * `/api/files/<absolute path>`, or by calling `show_files`, whose structured
 * output IS a card (`config/prompts/chat-files.md`). What has to hold for
 * either to be worth anything: the card LOADS from the origin+token URL, it
 * names the file's real place on disk, an HTML document runs only inside a
 * frame that carries `sandbox` without `allow-same-origin`, and a file the app
 * does not serve is still left exactly as authored.
 *
 * `docs/served-files.md` is the contract.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__ = "tok-1";
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  delete (window as { __ASSISTANT_TOKEN__?: string }).__ASSISTANT_TOKEN__;
  vi.unstubAllGlobals();
});

function render(text: string): void {
  renderNode(<Markdown text={text} />);
}

function renderNode(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

it("renders an explicit host image as a bare lazy embed", () => {
  render("![the plot](/api/files/tmp/example/plot.png)");
  // Absolute (the API server's origin is a different port under Vite) and
  // carrying the token an `<img>` cannot send as a header.
  const src = new URL(container!.querySelector("img")!.getAttribute("src")!);
  expect(src.pathname).toBe("/api/files/tmp/example/plot.png");
  expect(src.searchParams.get("token")).toBe("tok-1");
  expect(container!.querySelector("img")?.getAttribute("loading")).toBe("lazy");
  expect(container!.textContent).not.toContain("Preview only");
  // The picture enlarges, but nothing around it is card chrome: the only
  // control is the invisible one the image itself is.
  expect(container!.querySelectorAll("button")).toHaveLength(1);
  expect(
    container!.querySelector('button[title="Click to enlarge"]')?.textContent,
  ).toBe("");
});

it("keeps Markdown link presentation while decoding its internal viewer href", () => {
  render("[report](/api/files/tmp/example/My%20Docs/q3%20report.md)");
  const link = container!.querySelector<HTMLAnchorElement>("a");
  expect(link?.textContent).toBe("report");
  expect(link?.getAttribute("href")).toBe(
    "/files/tmp/example/My%20Docs/q3%20report.md",
  );
  expect(container!.textContent).not.toContain("Preview only");
});

it("degrades unsupported explicit embeds to an internal viewer link", () => {
  render("![report](/api/files/tmp/example/report.pdf)");
  const viewer = container!.querySelector('a[href^="/files/"]');
  expect(viewer?.getAttribute("href")).toBe("/files/tmp/example/report.pdf");
  expect(container!.querySelector("iframe")).toBeNull();
});

it("does not mint or load HTML until the embed becomes visible", async () => {
  let reveal!: (entries: Array<{ isIntersecting: boolean }>) => void;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof reveal) {
        reveal = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/g1/page.html",
          expiresAt: Date.now() + 3_600_000,
          delivery: "inline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  render("![preview](/api/files/tmp/example/page.html)");
  expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => {
    reveal([{ isIntersecting: true }]);
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledOnce();
});

it("runs an HTML document only in a frame with no same-origin access", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            url: "/api/file-grants/g1/page.html",
            expiresAt: Date.now() + 3_600_000,
            delivery: "inline",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ),
  );
  render("![preview](/api/files/tmp/example/page.html)");
  // The grant is minted at view time, so the frame appears once it answers.
  await act(async () => {
    await Promise.resolve();
  });
  const frame = container!.querySelector("iframe");
  expect(frame?.getAttribute("src")).toContain("/api/file-grants/g1/page.html");
  const sandbox = frame?.getAttribute("sandbox") ?? "";
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
  // The document is never fetched into the app; only its grant URL is.
  expect(frame?.getAttribute("srcdoc")).toBeNull();
  expect(container!.querySelector("[class*='shadow']")).toBeNull();
  expect(container!.textContent).toContain("Open in viewer");
});

it("runs every internal HTML source only through a token-free grant", async () => {
  let count = 0;
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      count += 1;
      const body = JSON.parse(String(init?.body)) as {
        target: { path: string };
      };
      return new Response(
        JSON.stringify({
          url: `/api/file-grants/g${count}/${body.target.path.split("/").pop()}`,
          expiresAt: Date.now() + 3_600_000,
          delivery: "inline",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  vi.stubGlobal("fetch", fetchSpy);
  render(
    [
      "![artifact](/api/session-artifacts/s1/tool-output/page.html)",
      "![knowledge](/api/knowledge/asset?id=kb-1&path=assets%2Fpage.html)",
      "![worktree](/worktrees/w1/files?path=docs%2Fpage.html)",
    ].join("\n\n"),
  );
  await act(async () => Promise.resolve());

  expect(container!.querySelectorAll("iframe")).toHaveLength(3);
  expect(fetchSpy).toHaveBeenCalledTimes(3);
  for (const frame of container!.querySelectorAll("iframe")) {
    expect(frame.src).toContain("/api/file-grants/");
    expect(frame.src).not.toContain("token=");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  }
  const targets = fetchSpy.mock.calls.map((call) =>
    JSON.parse(String(call[1]?.body)),
  );
  expect(targets.map((request) => request.target.kind)).toEqual([
    "sessionArtifact",
    "knowledgeAsset",
    "worktreeFile",
  ]);
  expect(targets.every((request) => request.scope === "directory")).toBe(true);
});

/** A finished `show_files` call, as the transcript replays it. */
function showFilesBlock(card: unknown, name = "show_files"): DisplayBlock {
  return {
    kind: "tool",
    toolId: "tc1",
    name,
    args: { paths: ["/tmp/example/plot.png"] },
    output: JSON.stringify({ renderKind: "showFiles", version: 1, card }),
    isError: false,
    done: true,
  };
}

function renderShowFiles(block: DisplayBlock, showTools = false): void {
  renderNode(
    <>{renderToolBlock(block as never, { showTools, expandTools: false })}</>,
  );
}

it("cards every file a show_files call showed, with tools hidden", () => {
  renderShowFiles(
    showFilesBlock({
      files: [
        {
          url: "/api/files/tmp/example/plot.png",
          name: "plot.png",
          label: "Weekly runs",
          size: 2048,
          snippet: "![Weekly runs](/api/files/tmp/example/plot.png)",
        },
        {
          url: "/api/session-artifacts/s1/tool-output/report.md",
          name: "report.md",
          label: "report.md",
          size: 4096,
          snippet:
            "[report.md](/api/session-artifacts/s1/tool-output/report.md)",
        },
      ],
    }),
  );

  // The picture is IN the card, loaded from the origin + token URL, and the
  // card names where the file sits and how big it is.
  const image = container!.querySelector("img")!;
  expect(new URL(image.src).pathname).toBe("/api/files/tmp/example/plot.png");
  expect(image.getAttribute("alt")).toBe("Weekly runs");
  expect(container!.textContent).toContain("/tmp/example/plot.png · 2.0 KB");
  expect(container!.textContent).toContain("report.md · 4.0 KB");

  // Each file keeps its own source identity, so each opens in its own viewer.
  const viewers = [...container!.querySelectorAll("a")].map((link) =>
    link.getAttribute("href"),
  );
  expect(viewers).toEqual([
    "/files/tmp/example/plot.png",
    "/artifacts/s1/tool-output/report.md",
  ]);
});

it("leaves a show_files result with no usable card as an ordinary tool block", () => {
  // A partial or malformed payload has no card to draw; with tools hidden the
  // block renders nothing at all rather than an empty tile.
  renderShowFiles(showFilesBlock({ files: [{ name: "plot.png" }] }));
  expect(container!.querySelector("img")).toBeNull();
  expect(container!.textContent).toBe("");
});

it("draws no card for an address this app does not serve", () => {
  // A tool payload is untrusted data. A foreign origin whose pathname merely
  // looks like ours, and an app-relative path that is not a served source, must
  // not become an automatic `<img>` or an external card: a card resolves
  // through the origin-checked resolver or it does not exist.
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  for (const url of [
    "https://evil.example/api/files/tmp/example/plot.png",
    "/api/knowledge/file?path=notes.md",
    "/not/served/plot.png",
  ]) {
    renderShowFiles(
      showFilesBlock({
        files: [
          {
            url,
            name: "plot.png",
            label: "Weekly runs",
            size: 10,
            // The crafted shape that would otherwise force an `<img>`.
            mimeType: "image/png",
          },
        ],
      }),
    );
    expect(container!.querySelector("img")).toBeNull();
    expect(container!.querySelector("a")).toBeNull();
    expect(container!.textContent).toBe("");
    act(() => root!.unmount());
    container!.remove();
  }
  expect(fetchSpy).not.toHaveBeenCalled();
  container = null;
  root = null;
});

it("classifies a show_files row by its address, not by what it claims", () => {
  // A crafted row declaring `image/png` for a Markdown document must not force
  // image presentation — the kind comes from the resolved target alone.
  renderShowFiles(
    showFilesBlock({
      files: [
        {
          url: "/api/files/tmp/example/report.md",
          name: "report.md",
          label: "report.md",
          size: 0,
          mimeType: "image/png",
          kind: "image",
          snippet: "[report.md](/api/files/tmp/example/report.md)",
        },
      ],
    }),
  );
  expect(container!.querySelector("img")).toBeNull();
  expect(container!.textContent).toContain("Open the viewer to read it");
  // A zero-byte file has a size like any other; it is not a missing one.
  expect(container!.textContent).toContain("/tmp/example/report.md · 0 B");
});

it("cards a show_files result under either harness's tool name", () => {
  renderShowFiles(
    showFilesBlock(
      {
        files: [
          {
            url: "/api/files/tmp/example/notes.md",
            name: "notes.md",
            label: "notes.md",
            size: 512,
            snippet: "[notes.md](/api/files/tmp/example/notes.md)",
          },
        ],
      },
      "mcp__pa__show_files",
    ),
  );
  expect(
    container!.querySelector('a[href="/files/tmp/example/notes.md"]'),
  ).not.toBeNull();
});

it("degrades an HTML source whose directory grant is refused to its viewer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unsafe source", { status: 400 })),
  );
  render("![artifact](/api/session-artifacts/s1/page.html)");
  await act(async () => Promise.resolve());
  expect(container!.querySelector("iframe")).toBeNull();
  expect(
    container!.querySelector('a[href="/artifacts/s1/page.html"]'),
  ).not.toBeNull();
});

it("opens a captured artifact in its first-class internal viewer", () => {
  render("[report](/api/session-artifacts/s1/tool-output/report.html)");
  const link = container!.querySelector<HTMLAnchorElement>("a");
  expect(link?.getAttribute("href")).toBe(
    "/artifacts/s1/tool-output/report.html",
  );
  expect(link?.getAttribute("target")).toBeNull();
  expect(container!.querySelector("iframe")).toBeNull();
});

it("offers the viewer for a source file, which the server serves as text", () => {
  // The server hands `.py` over as readable `text/plain`, so the card must not
  // reduce it to a download; the shared classification is what keeps the two
  // halves agreeing.
  render("[script](/api/files/tmp/example/train.py)");
  expect(
    container!.querySelector('a[href^="/files/"]')?.getAttribute("href"),
  ).toBe("/files/tmp/example/train.py");
  expect(container!.textContent).toBe("script");
});

it("leaves an image the app does not serve exactly as authored", () => {
  render("![external](https://example.com/a.png)");
  const img = container!.querySelector("img");
  expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
  expect(container!.textContent).not.toContain("Preview only");
});

it("never treats foreign lookalike links, embeds, or cards as local", () => {
  const foreign = "https://evil.example/api/files/tmp/example/page.html";
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  render(`[external](${foreign})`);
  expect(container!.querySelector("a")?.getAttribute("href")).toBe(foreign);
  expect(container!.querySelector("a")?.getAttribute("target")).toBe("_blank");

  act(() => root!.unmount());
  container!.remove();
  render(`![external](${foreign})`);
  expect(container!.querySelector("img")?.getAttribute("src")).toBe(foreign);

  act(() => root!.unmount());
  container!.remove();
  renderNode(
    <ServedFileCard
      file={{
        url: foreign,
        name: "page.html",
        label: "Foreign",
        mimeType: "text/html",
        size: 10,
      }}
    />,
  );
  expect(
    container!.querySelector('a[href="/files/tmp/example/page.html"]'),
  ).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("keeps an authored link instead of nesting an embed's controls in it", () => {
  // `Markdown.linkedEmbed.test.tsx` owns this rule; here it only has to hold
  // for a host file. The link the author wrote stays, and the embed's own Play
  // control is not smuggled inside it.
  render(
    "[![recording](/api/files/tmp/example/clip.mp3)](https://example.com)",
  );
  expect(container!.querySelector("button")).toBeNull();
  const link = container!.querySelector("a")!;
  expect(link.getAttribute("href")).toBe("https://example.com");
  expect(link.textContent).toBe("recording");
  expect(link.querySelector("a")).toBeNull();
});

it("does not request audio until Play, then embeds only its source grant", async () => {
  const fetchSpy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          url: "/api/file-grants/media-1/clip.mp3",
          expiresAt: Date.now() + 3_600_000,
          delivery: "inline",
        }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchSpy);
  render("![recording](/api/files/tmp/example/clip.mp3)");
  expect(container!.querySelector("audio")).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
  const play = container!.querySelector<HTMLButtonElement>(
    'button[aria-label="Play recording"]',
  );
  await act(async () => {
    play!.click();
    await Promise.resolve();
  });
  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(container!.querySelector("audio")?.getAttribute("src")).toContain(
    "/api/file-grants/media-1/clip.mp3",
  );
  expect(container!.querySelector("audio")?.getAttribute("src")).not.toContain(
    "token=",
  );
});

it("resolves a document's own relative image against its directory", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <Markdown
        text="![dot](assets/dot.png)"
        documentDirectory="/tmp/example/report"
      />,
    ),
  );
  const src = new URL(container!.querySelector("img")!.getAttribute("src")!);
  expect(src.pathname).toBe("/api/files/tmp/example/report/assets/dot.png");
  expect(src.searchParams.get("token")).toBe("tok-1");
  // A plain image, not a card: the viewer's header already names the document.
  expect(container!.textContent).not.toContain("Preview only");
});
