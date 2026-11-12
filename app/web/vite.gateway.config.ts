import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { webAliases } from "./vite.config.ts";

/**
 * The gateway's own page (Task-1402, `src/gateway/`): its own entry and
 * output directory, which the edge serves and nothing else. None of Pandeck's
 * token, notice or public files: the page carries no token and no config, and
 * its CSP (`default-src 'self'`) admits no inline script.
 */
export default defineConfig(({ command }) => {
  // As `vite.config.ts`: a serve that inherits NODE_ENV=production renders a
  // blank page.
  if (command === "serve" && process.env.NODE_ENV === "production")
    process.env.NODE_ENV = "development";
  return {
    plugins: [react(), tailwindcss()],
    publicDir: false,
    build: {
      outDir: "dist-gateway",
      emptyOutDir: true,
      // Inlined assets would be `data:` URLs, which the CSP refuses.
      assetsInlineLimit: 0,
      rolldownOptions: { input: "gateway.html" },
    },
    resolve: { alias: webAliases },
  };
});
