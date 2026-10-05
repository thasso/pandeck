import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveAuthToken } from "../server/src/authToken.ts";
import { resolveBuildInfo } from "../server/src/buildInfo.ts";

const TOKEN_PLACEHOLDER = '"%ASSISTANT_TOKEN%"';

// The shared secret is injected into index.html at serve time, never baked into
// the built JS bundle (so a Nix/prod build carries no secret). In dev, Vite —
// not the Node server — serves index.html, so this plugin replaces the
// placeholder with the same file-backed token the API/WS server resolves. It is
// `apply: "serve"` only: `vite build` leaves the placeholder literal for the
// Node server to replace at runtime (see app/server/src/index.ts).
function assistantTokenDevPlugin(): Plugin {
  return {
    name: "assistant-token-dev",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replaceAll(
        TOKEN_PLACEHOLDER,
        JSON.stringify(resolveAuthToken()),
      );
    },
  };
}

const DEFAULT_CHUNK_BUDGET_KB = 500;
// Lazy Shiki grammar/wasm data chunks (loaded per language on demand, both by
// the app highlighter and @pierre/diffs) get a higher allowance: they are pure
// generated data, split per language, and never part of the initial load.
const SHIKI_DATA_CHUNK_BUDGET_KB = 800;

function isShikiDataChunk(moduleIds: string[]): boolean {
  return (
    moduleIds.length > 0 &&
    moduleIds.every((id) => /node_modules\/(@shikijs|shiki)\//.test(id))
  );
}

function chunkBudgetPlugin(): Plugin {
  return {
    name: "assistant-chunk-budget",
    generateBundle(_, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk" || typeof chunk.code !== "string") continue;
        const budgetKb = isShikiDataChunk(chunk.moduleIds ?? [])
          ? SHIKI_DATA_CHUNK_BUDGET_KB
          : DEFAULT_CHUNK_BUDGET_KB;
        const sizeKb = new TextEncoder().encode(chunk.code).length / 1024;
        if (sizeKb > budgetKb) {
          this.warn(
            `${fileName} is ${sizeKb.toFixed(1)} KB, exceeds ${budgetKb} KB chunk budget`,
          );
        }
      }
    },
  };
}

// Vite derives `isProduction` solely from an ambient `NODE_ENV` — it only
// defaults it (to "development" for `serve`) when the variable is unset. So a
// dev server started from an environment that already exports
// `NODE_ENV=production` (e.g. an agent shell spawned by the deployed systemd
// service, whose unit sets it) silently becomes a "production" serve:
// @vitejs/plugin-react then skips its Fast Refresh preamble while the JSX
// transform still emits `$RefreshSig$()` calls, and the first component module
// dies with "$RefreshSig$ is not defined" — a blank page. `vite build` sets
// NODE_ENV=production itself, so only `serve` needs correcting.
function forceDevNodeEnvForServe(command: string): void {
  if (command === "serve" && process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "development";
  }
}

export default defineConfig(({ command }) => {
  forceDevNodeEnvForServe(command);
  return {
    // The bundle's own build identity, resolved ONCE here because the browser
    // can never ask: it is static assets by the time anyone looks. The same
    // resolver the server uses, so Settings → About compares like with like
    // (`app/server/src/buildInfo.ts`).
    define: {
      __ASSISTANT_BUILD__: JSON.stringify(resolveBuildInfo()),
    },
    plugins: [
      react(),
      tailwindcss(),
      chunkBudgetPlugin(),
      assistantTokenDevPlugin(),
    ],
    build: {
      // Vite's built-in warning is global, so set it to the lazy Shiki-data
      // allowance and enforce the default 500 KB budget with
      // `assistant-chunk-budget` above for every other chunk.
      chunkSizeWarningLimit: SHIKI_DATA_CHUNK_BUDGET_KB,
      // The dictation AudioWorklet is small enough that Vite would inline it as a
      // `data:text/javascript` URL — but `audioWorklet.addModule()` does not
      // reliably accept data URLs (Chrome rejects them), so it must stay a real
      // fetchable asset. Everything else keeps the default inlining behavior.
      assetsInlineLimit: (filePath) =>
        filePath.endsWith("pcm16Worklet.js") ? false : undefined,
    },
    resolve: {
      // Consume the shared package from source so both toolchains agree. Subpath
      // entries must precede the root so prefix matching resolves them first.
      alias: {
        "@assistant/shared/buildInfo": fileURLToPath(
          new URL("../shared/buildInfo.ts", import.meta.url),
        ),
        "@assistant/shared/session": fileURLToPath(
          new URL("../shared/session/index.ts", import.meta.url),
        ),
        "@assistant/shared/runtime": fileURLToPath(
          new URL("../shared/runtimeEvents.ts", import.meta.url),
        ),
        "@assistant/shared/display": fileURLToPath(
          new URL("../shared/displayMapping.ts", import.meta.url),
        ),
        "@assistant/shared/turnStats": fileURLToPath(
          new URL("../shared/turnStats.ts", import.meta.url),
        ),
        "@assistant/shared/objectLinks": fileURLToPath(
          new URL("../shared/objectLinks.ts", import.meta.url),
        ),
        "@assistant/shared/comments": fileURLToPath(
          new URL("../shared/comments.ts", import.meta.url),
        ),
        "@assistant/shared/usage": fileURLToPath(
          new URL("../shared/usage.ts", import.meta.url),
        ),
        "@assistant/shared/servedFiles": fileURLToPath(
          new URL("../shared/servedFiles.ts", import.meta.url),
        ),
        "@assistant/shared/documentTargets": fileURLToPath(
          new URL("../shared/documentTargets.ts", import.meta.url),
        ),
        "@assistant/shared/portForwarding": fileURLToPath(
          new URL("../shared/portForwarding.ts", import.meta.url),
        ),
        "@assistant/shared/settingsRegistry": fileURLToPath(
          new URL("../shared/settingsRegistry.ts", import.meta.url),
        ),
        "@assistant/shared/toolCards": fileURLToPath(
          new URL("../shared/toolCards.ts", import.meta.url),
        ),
        "@assistant/shared/frontmatter": fileURLToPath(
          new URL("../shared/frontmatter.ts", import.meta.url),
        ),
        "@assistant/shared/zonedTime": fileURLToPath(
          new URL("../shared/zonedTime.ts", import.meta.url),
        ),
        "@assistant/shared": fileURLToPath(
          new URL("../shared/protocol.ts", import.meta.url),
        ),
      },
    },
    // No proxy: the client talks to the server directly (see socket.ts
    // `defaultSocketUrl`). This keeps the Vite dev server a pure asset/HMR server
    // with zero coupling to the API server, so server reloads never disturb it.
    server: {
      // Bind to all interfaces in dev so the UI is reachable from a phone on the
      // same network via http://<this-machine-ip>:5173.
      host: "0.0.0.0",
      // Dev-only convenience: allow access by LAN IP / arbitrary hostnames.
      // Do not carry this over to production hosting.
      allowedHosts: true,
      port: 5173,
    },
  };
});
