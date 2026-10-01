import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import {
  isStoryPreviewId,
  storyCatalog,
  type StoryPreviewDefinition,
} from "./storyCatalog.ts";

const previewRoot = import.meta.dirname;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

/**
 * The chat HTML viewer gives documents an opaque origin. ES module scripts then
 * require CORS even beside the document, so the story ships as one classic IIFE.
 * The outer document clips a nested canvas whose own viewport matches the case:
 * a 256px desktop rail still evaluates desktop media queries, while the 390px
 * phone story evaluates the phone ones.
 */
function previewDocuments(
  storyId: string,
  definition: StoryPreviewDefinition,
  revision: string,
): Plugin {
  const dark = definition.theme === "dark";
  const background = dark ? "#0b0c10" : "#f7f8fa";
  const panel = dark ? "#1b1f2d" : "#ffffff";
  const line = dark ? "#3c4458" : "#e8eaef";
  const foreground = dark ? "#e7e9ee" : "#1a1d26";
  const muted = dark ? "#99a0ae" : "#5b6472";
  const title = escapeHtml(definition.title);
  const safeStoryId = escapeHtml(storyId);
  const safeRevision = escapeHtml(revision);

  return {
    name: "component-preview-documents",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "index.html",
        source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>
      :root { color-scheme: ${dark ? "dark" : "light"}; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
      * { box-sizing: border-box; }
      body { margin: 0; overflow-x: hidden; background: ${background}; color: ${foreground}; font: 11px/1.4 system-ui, sans-serif; }
      header { height: 30px; overflow: hidden; white-space: nowrap; padding: 7px 8px; border-bottom: 1px solid ${line}; background: ${panel}; text-overflow: ellipsis; }
      strong { font-size: 12px; }
      span { color: ${muted}; }
      .canvas-viewport { width: 100%; overflow: hidden; }
      .canvas-size { position: relative; }
      .canvas-stage { transform-origin: left top; }
      .canvas-clip { width: ${definition.frameWidth}px; height: ${definition.canvasHeight}px; overflow: hidden; background: ${panel}; }
      iframe { display: block; width: ${definition.canvasWidth}px; height: ${definition.canvasHeight}px; border: 0; }
    </style>
  </head>
  <body>
    <header title="${safeStoryId}">
      <strong>${title}</strong>
      <span> · ${definition.frameWidth}px · ${definition.theme} · ${definition.textScale}% · ${safeRevision}</span>
    </header>
    <div class="canvas-viewport">
      <div class="canvas-size">
        <div class="canvas-stage">
          <div class="canvas-clip">
            <iframe src="./story.html" title="${title}"></iframe>
          </div>
        </div>
      </div>
    </div>
    <script>
      const frameWidth = ${definition.frameWidth};
      const frameHeight = ${definition.canvasHeight};
      const size = document.querySelector('.canvas-size');
      const stage = document.querySelector('.canvas-stage');
      const fit = () => {
        const scale = Math.min(1, document.documentElement.clientWidth / frameWidth);
        stage.style.transform = 'scale(' + scale + ')';
        size.style.width = frameWidth * scale + 'px';
        size.style.height = frameHeight * scale + 'px';
      };
      addEventListener('resize', fit);
      fit();
    </script>
  </body>
</html>
`,
      });
      this.emitFile({
        type: "asset",
        fileName: "story.html",
        source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <style>html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }</style>
    <link rel="stylesheet" href="./preview.css" />
  </head>
  <body>
    <div id="root"></div>
    <script src="./preview.js"></script>
  </body>
</html>
`,
      });
    },
  };
}

export default defineConfig(() => {
  const storyId = process.env.PA_PREVIEW_STORY ?? "";
  // Storybook discovers this neighbouring Vite config as its base. Its own
  // `viteFinal` supplies what the manager needs; the chat-only build is enabled
  // only when the adapter selects a story.
  if (!storyId) return {};
  if (!isStoryPreviewId(storyId))
    throw new Error(`Unknown PA_PREVIEW_STORY: ${storyId}`);
  const definition = storyCatalog[storyId];
  const outDir = process.env.PA_PREVIEW_OUT_DIR;
  if (!outDir) throw new Error("PA_PREVIEW_OUT_DIR is required.");
  const revision = process.env.PA_PREVIEW_REVISION ?? "working tree";

  return {
    root: previewRoot,
    publicDir: false as const,
    base: "./",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      __PA_PREVIEW_STORY__: JSON.stringify(storyId),
    },
    plugins: [
      react(),
      tailwindcss(),
      previewDocuments(storyId, definition, revision),
    ],
    build: {
      outDir: resolve(outDir),
      emptyOutDir: true,
      cssCodeSplit: false,
      lib: {
        entry: resolve(previewRoot, "main.tsx"),
        name: "PaComponentPreview",
        formats: ["iife" as const],
        fileName: () => "preview.js",
        cssFileName: "preview",
      },
    },
  };
});
